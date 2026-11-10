import type { CalibrationReport, CalibrationResult, LanguageKey } from '@cb/contracts';
import { withTransaction, type Db, type Executor } from '@cb/db';
import { AppError } from '@cb/errors';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { addJobToOutbox } from '@cb/queue';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { calibrations, type CalibrationRow, type CalibrationRunJson } from '../../db/schema.js';
import type { BlobStore } from '../../lib/blobs.js';
import { problemsRepository as problemsRepo } from '../problems/problems.repository.js';
import type { ProblemService } from '../problems/problems.service.js';
import { calibrate } from './calibration-rules.js';
import type { JudgeClient } from './judge-client.js';

export const CALIBRATE_QUEUE = 'problem-calibrate';
/** Asked of the judge for every reference run; it caps this at the Judge0 instance maximum. */
const MEASURE_CPU_MS = 15_000;

export interface CalibrationServiceDeps {
  db: Db;
  problems: ProblemService;
  blobs: BlobStore;
  judge: JudgeClient;
  logger: Logger;
  pollIntervalMs?: number;
  timeoutMs?: number;
  afterCommit?: () => void;
}

export function toReport(c: CalibrationRow): CalibrationReport {
  return {
    id: c.id,
    version: c.version,
    status: c.status,
    runs: c.runs.map((r) => ({ ...r, languageKey: r.languageKey as LanguageKey })),
    limits: c.limits.map((l) => ({ ...l, languageKey: l.languageKey as LanguageKey })),
    problems: c.problems,
    createdAt: c.createdAt.toISOString(),
    finishedAt: c.finishedAt?.toISOString() ?? null,
  };
}

export async function latestCalibration(
  ex: Executor,
  problemId: string,
): Promise<CalibrationRow | undefined> {
  const [c] = await ex
    .select()
    .from(calibrations)
    .where(eq(calibrations.problemId, problemId))
    .orderBy(desc(calibrations.createdAt))
    .limit(1);
  return c;
}

/**
 * Calibration (plan §14.7): run every reference solution on every file through the judge, derive
 * per-language limits, check the references behave as declared, and only then mark the version
 * calibrated. One calibration per problem version at a time.
 */
export class CalibrationService {
  constructor(private readonly d: CalibrationServiceDeps) {}

  async request(problemId: string, userId: string): Promise<CalibrationReport> {
    const row = await withTransaction(this.d.db, async (tx) => {
      const p = await problemsRepo.findById(tx, problemId, { forUpdate: true });
      if (!p) throw new AppError('NOT_FOUND', 404, 'Problem not found');
      const [files, refs] = await Promise.all([
        problemsRepo.files(tx, problemId),
        problemsRepo.references(tx, problemId),
      ]);
      const blockers = [
        ...(files.length ? [] : [{ code: 'NO_FILES', message: 'Upload test files first' }]),
        ...(refs.some((r) => r.languageKey === 'cpp' && r.expectedVerdict === 'AC')
          ? []
          : [{ code: 'NO_CPP_AC_REFERENCE', message: 'Add an accepted C++ reference solution first' }]),
      ];
      if (blockers.length)
        throw new AppError('PROBLEM_NOT_PUBLISHABLE', 422, 'Problem is not ready to calibrate', {
          details: blockers,
        });

      const [active] = await tx
        .select()
        .from(calibrations)
        .where(
          and(
            eq(calibrations.problemId, problemId),
            eq(calibrations.version, p.version),
            inArray(calibrations.status, ['pending', 'running']),
          ),
        );
      if (active) return active;

      const [c] = await tx
        .insert(calibrations)
        .values({ id: newId(), problemId, version: p.version, status: 'pending', requestedBy: userId })
        .returning();
      await addJobToOutbox(tx, {
        queue: CALIBRATE_QUEUE,
        jobId: `calibrate-${c!.id}`,
        name: 'calibrate',
        data: { calibrationId: c!.id },
      });
      return c!;
    });
    this.d.afterCommit?.();
    return toReport(row);
  }

  async latest(problemId: string): Promise<CalibrationReport | null> {
    const c = await latestCalibration(this.d.db, problemId);
    return c ? toReport(c) : null;
  }

  /** problem-calibrate job. Safe to retry: judge runs are idempotent by requestKey. */
  async run(calibrationId: string): Promise<void> {
    const [c] = await this.d.db
      .update(calibrations)
      .set({ status: 'running' })
      .where(and(eq(calibrations.id, calibrationId), inArray(calibrations.status, ['pending', 'running'])))
      .returning();
    if (!c) return;

    const finish = async (status: 'passed' | 'failed', patch: Partial<CalibrationRow>) => {
      await this.d.db
        .update(calibrations)
        .set({ status, finishedAt: sql`now()`, ...patch })
        .where(eq(calibrations.id, calibrationId));
    };

    const p = await problemsRepo.findById(this.d.db, c.problemId);
    if (!p || p.version !== c.version) {
      return finish('failed', {
        problems: [
          { code: 'PROBLEM_CHANGED', message: 'The problem changed while calibrating; run it again' },
        ],
      });
    }
    const [files, refs] = await Promise.all([
      problemsRepo.files(this.d.db, p.id),
      problemsRepo.references(this.d.db, p.id),
    ]);

    // Start every reference run, then wait for all of them.
    const started = await Promise.all(
      refs.map(async (ref) => {
        const code = (await this.d.blobs.get(this.d.db, ref.codeUri))?.toString('utf8');
        if (!code) throw new Error(`reference ${ref.id} code is missing`);
        const res = await this.d.judge.startCalibration({
          problemId: p.id,
          languageKey: ref.languageKey as LanguageKey,
          code,
          cpuLimitMs: MEASURE_CPU_MS,
          requestKey: `${calibrationId}-${ref.id}`,
        });
        return { ref, id: res.id };
      }),
    );
    const results = new Map<string, CalibrationResult>();
    const deadline = Date.now() + (this.d.timeoutMs ?? 10 * 60_000);
    while (results.size < started.length) {
      if (Date.now() > deadline) {
        return finish('failed', {
          problems: [
            { code: 'JUDGE_TIMEOUT', message: 'The judge did not finish the reference runs in time' },
          ],
        });
      }
      for (const s of started) {
        if (results.has(s.id)) continue;
        const r = await this.d.judge.calibration(s.id);
        if (r.status === 'done') results.set(s.id, r);
      }
      if (results.size < started.length)
        await new Promise((r) => setTimeout(r, this.d.pollIntervalMs ?? 1000));
    }

    const all = started.map((s) => ({ ref: s.ref, res: results.get(s.id)! }));
    if (all.some(({ res }) => res.problemVersion !== c.version)) {
      return finish('failed', {
        problems: [
          { code: 'PROBLEM_CHANGED', message: 'The problem changed while calibrating; run it again' },
        ],
      });
    }
    const runs: CalibrationRunJson[] = all.flatMap(({ ref, res }) =>
      res.files.map((f) => ({
        referenceId: ref.id,
        languageKey: ref.languageKey,
        expectedVerdict: ref.expectedVerdict,
        ordinal: f.ordinal,
        verdict: f.verdict,
        cpuMs: f.cpuMs,
      })),
    );
    const outcome = calibrate({
      ordinals: files.map((f) => f.ordinal),
      runs: runs.map((r) => ({ ...r, languageKey: r.languageKey as LanguageKey })),
      instanceMaxMs: Math.min(...all.map(({ res }) => res.cpuLimitMs)),
    });

    if (outcome.problems.length)
      return finish('failed', { runs, limits: outcome.limits, problems: outcome.problems });
    try {
      await this.d.problems.applyCalibration(p.id, c.version, outcome.limits);
    } catch (err) {
      this.d.logger.warn({ err, calibrationId }, 'could not apply calibration');
      return finish('failed', {
        runs,
        limits: outcome.limits,
        problems: [
          { code: 'PROBLEM_CHANGED', message: 'The problem changed while calibrating; run it again' },
        ],
      });
    }
    await finish('passed', { runs, limits: outcome.limits, problems: [] });
  }
}
