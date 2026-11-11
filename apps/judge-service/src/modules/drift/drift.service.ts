import type { DriftStatus } from '@cb/contracts';
import type { Db } from '@cb/db';
import { newId } from '@cb/ids';
import { driftOutcome, isFinalStatus, J0, requestLimits, type InstanceLimits } from '@cb/judge-core';
import type { Logger } from '@cb/logger';
import { and, asc, desc, isNotNull, isNull } from 'drizzle-orm';
import { judgeDriftChecks, type DriftCheckRow } from '../../db/schema.js';
import type { CodeExecutor } from '../../judge0/executor.js';
import { JUDGE0_PROCESSES } from '../../judge0/languages.js';
import { judgingRepository as repo } from '../judging/judging.repository.js';

/**
 * Fixed CPU-bound programs (plan §14.8). Never change them: the baseline is only comparable with
 * the same code. They read no input and print one number.
 */
export const BENCHMARKS = {
  cpp: `#include <cstdio>
int main() {
  volatile unsigned long long x = 0;
  for (unsigned long long i = 0; i < 200000000ULL; i++) x = x * 6364136223846793005ULL + i;
  printf("%llu\\n", (unsigned long long)(x % 1000));
}
`,
  python: `s = 0
for i in range(3000000):
    s = (s * 31 + i) % 1000003
print(s)
`,
} as const;
type Bench = keyof typeof BENCHMARKS;

export interface DriftServiceDeps {
  db: Db;
  executor: CodeExecutor;
  logger: Logger;
  instance: () => InstanceLimits;
  dailyBudget: number;
  matchReserveCalls: number;
  pollIntervalMs?: number;
}

/** Plan §14.8: weekly benchmark, compared with the baseline; the factor scales every CPU limit. */
export class DriftService {
  private current = 1;

  constructor(private readonly d: DriftServiceDeps) {}

  /** The factor CPU limits are multiplied by (1 until drift is detected). */
  factor(): number {
    return this.current;
  }

  /** Read the factor in force from the database (boot, and periodically in every process). */
  async load(): Promise<number> {
    const [latest] = await this.d.db
      .select()
      .from(judgeDriftChecks)
      .where(isNull(judgeDriftChecks.error))
      .orderBy(desc(judgeDriftChecks.ranAt))
      .limit(1);
    this.current = latest ? Number(latest.factor) : 1;
    return this.current;
  }

  /** judge-drift job: one batch request with every benchmark. */
  async check(): Promise<DriftCheckRow> {
    const record = async (row: Partial<DriftCheckRow>) => {
      const [r] = await this.d.db
        .insert(judgeDriftChecks)
        .values({ id: newId(), factor: String(this.current), ...row })
        .returning();
      return r!;
    };
    const fail = async (error: string) => {
      this.d.logger.warn({ error }, 'drift check failed; keeping the current factor');
      return record({ error });
    };

    const usage = await repo.usage(this.d.db, this.d.dailyBudget);
    if (usage.limit - usage.used - 1 < this.d.matchReserveCalls)
      return fail('not enough judge quota left today');
    const profiles = new Map((await repo.profiles(this.d.db)).map((p) => [p.languageKey, p]));
    const benches = (Object.keys(BENCHMARKS) as Bench[]).filter((b) => profiles.has(b));
    if (!benches.length) return fail('no benchmark language is configured');

    const instance = this.d.instance();
    const limits = (lang: Bench) =>
      requestLimits({
        cpuLimitMs: 10_000,
        memoryLimitKb: 262_144,
        outputLimitKb: 64,
        lang: { memOverheadKb: profiles.get(lang)!.memOverheadKb, maxProcesses: JUDGE0_PROCESSES },
        instance,
      });

    let tokens: (string | null)[];
    try {
      await repo.reserveCalls(this.d.db, 1, this.d.dailyBudget, true);
      tokens = await this.d.executor.submitBatch(
        benches.map((b) => ({
          languageId: profiles.get(b)!.judge0LanguageId,
          sourceCode: BENCHMARKS[b],
          stdin: '',
          limits: limits(b),
        })),
      );
    } catch (err) {
      return fail(`submit failed: ${(err as Error).message}`);
    }
    if (tokens.some((t) => !t)) return fail('the judge rejected a benchmark');

    const samples: Record<string, number> = {};
    for (let attempt = 0; attempt < 60 && Object.keys(samples).length < benches.length; attempt++) {
      await new Promise((r) => setTimeout(r, this.d.pollIntervalMs ?? 1000));
      let results;
      try {
        results = await this.d.executor.fetchBatch(tokens as string[]);
      } catch (err) {
        this.d.logger.warn({ err }, 'drift check: polling failed; retrying');
        continue;
      }
      for (const [i, r] of results.entries()) {
        if (!isFinalStatus(r.statusId)) continue;
        if (r.statusId !== J0.ACCEPTED || r.time === null) {
          return fail(`${benches[i]} benchmark ended with status ${r.statusId}`);
        }
        samples[benches[i]!] = Math.round(r.time * 1000);
      }
    }
    if (Object.keys(samples).length < benches.length) return fail('no result from the judge in time');

    const history = (await this.successful()).map((c) => c.samples!);
    const outcome = driftOutcome(history, samples);
    this.current = outcome.factor;
    this.d.logger.info({ samples, ...outcome }, 'drift check done');
    return record({
      samples,
      ratio: outcome.ratio === null ? null : String(outcome.ratio),
      factor: String(outcome.factor),
    });
  }

  async status(): Promise<DriftStatus> {
    const history = await this.successful();
    const [last] = await this.d.db
      .select()
      .from(judgeDriftChecks)
      .orderBy(desc(judgeDriftChecks.ranAt))
      .limit(1);
    const latest = history.at(-1);
    // For display the baseline exists as soon as three checks did (the factor itself is decided in
    // check(), which compares a new sample with the checks before it).
    const outcome = latest
      ? driftOutcome(
          history.map((c) => c.samples!),
          latest.samples!,
        )
      : null;
    return {
      factor: await this.load(),
      ratio: outcome?.ratio ?? null,
      baseline: outcome?.baseline ?? null,
      checks: history.length,
      lastCheck: last
        ? { ranAt: last.ranAt.toISOString(), samples: last.samples ?? null, error: last.error }
        : null,
    };
  }

  private successful(): Promise<DriftCheckRow[]> {
    return this.d.db
      .select()
      .from(judgeDriftChecks)
      .where(and(isNull(judgeDriftChecks.error), isNotNull(judgeDriftChecks.samples)))
      .orderBy(asc(judgeDriftChecks.ranAt));
  }
}
