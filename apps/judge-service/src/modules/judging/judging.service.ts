import { counter, histogram } from '@cb/metrics';
import { judgeEvents, type JudgeSpec, type LanguageKey } from '@cb/contracts';
import { withTransaction, type Db, type Tx } from '@cb/db';
import type { OutboxWriter } from '@cb/events';
import { newId } from '@cb/ids';
import {
  decide,
  isFinalStatus,
  J0,
  judgeFile,
  requestLimits,
  requestsFor,
  type FileOutcome,
  type InstanceLimits,
  type RequestLimits,
  type RunResult,
} from '@cb/judge-core';
import type { Logger } from '@cb/logger';
import type { Queue } from 'bullmq';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JudgeRunRow, LanguageProfileRow, SubmissionRow } from '../../db/schema.js';
import { normalizeResult, type CodeExecutor } from '../../judge0/executor.js';
import { JUDGE0_PROCESSES } from '../../judge0/languages.js';
import { loadFileSpec, type ProblemSource } from '../../problems/problem-source.js';
import { POLL_DELAYS_MS } from '../../queues.js';
import { judgingRepository as repo } from './judging.repository.js';

/** CPU limit for files without a calibrated one (drafts, calibration runs), before the language factor. */
export const DEFAULT_CPU_MS = 2000;
const CUSTOM_INPUT = 0;

export interface JudgingDeps {
  db: Db;
  executor: CodeExecutor;
  problems: ProblemSource;
  outbox: OutboxWriter;
  logger: Logger;
  pollQueue: Queue;
  mode: 'poll' | 'callback';
  callbackBaseUrl?: string;
  callbackSecret?: string;
  dailyBudget: number;
  /** Plan §14.8: multiplies every CPU limit (1 unless the hosted judge drifted). */
  driftFactor?: () => number;
  /** False while the BullMQ Redis is unreachable: polls are then driven by the degraded loop. */
  queueHealthy?: () => boolean;
  afterCommit?: () => void;
}

type Spec = JudgeSpec;
type SpecFile = Spec['files'][number];

const failedResult = (message: string): RunResult => ({
  statusId: J0.INTERNAL_ERROR,
  time: null,
  wallTime: null,
  memoryKb: null,
  stdout: null,
  stderr: null,
  compileOutput: null,
  message,
});

const resultFromRow = (r: JudgeRunRow): RunResult => ({
  statusId: r.judge0StatusId ?? J0.INTERNAL_ERROR,
  time: r.cpuMs === null ? null : r.cpuMs / 1000,
  wallTime: r.wallMs === null ? null : r.wallMs / 1000,
  memoryKb: r.memKb,
  stdout: r.stdoutTrunc,
  stderr: r.stderrTrunc,
  compileOutput: r.compileOutput,
  message: r.message,
});

const finished = (r: JudgeRunRow) => r.status === 'done' || r.status === 'failed';

/** Latest attempt of each file. */
function latestRuns(runs: JudgeRunRow[]): Map<number, JudgeRunRow> {
  const m = new Map<number, JudgeRunRow>();
  for (const r of runs) {
    const cur = m.get(r.fileOrdinal);
    if (!cur || r.attempt > cur.attempt) m.set(r.fileOrdinal, r);
  }
  return m;
}

/**
 * Judging pipeline (plan §14.3–14.4). The worker never waits on Judge0: it submits a stage, then
 * results arrive by callback or polling, and `aggregate` decides what happens next.
 *   Submit: stage 1 = sample + small, stage 2 = large (only if stage 1 is all AC).
 *   Run:    stage 1 = sample (+ custom input as file 0, which has no verdict of its own).
 */
/** Where `elapsedMs` after a stage started falls in the poll schedule (delays.length = give up). */
export function pollIndex(elapsedMs: number, delays: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < delays.length; i++) {
    total += delays[i]!;
    if (elapsedMs < total) return i;
  }
  return delays.length;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

/** Plan §19: submit → verdict time (SLO: stage-1 p95 < 6 s on hosted Judge0) and verdict mix. */
const judgeLatency = histogram(
  'judge_latency_seconds',
  'Submission to verdict',
  ['mode'],
  [0.5, 1, 2, 4, 6, 10, 20, 40, 80],
);
const verdicts = counter('judge_verdicts_total', 'Final verdicts', ['mode', 'verdict', 'cached']);

export class JudgingService {
  private profiles = new Map<string, LanguageProfileRow>();
  private instance: InstanceLimits = {
    maxCpuSec: 15,
    maxWallSec: 20,
    maxMemKb: 256_000,
    maxStackKb: 128_000,
    maxFileKb: 4096,
  };
  private maxBatch = 20;

  constructor(private readonly d: JudgingDeps) {}

  queueDepth() {
    return repo.queueDepth(this.d.db);
  }

  /** Boot: what this Judge0 instance allows, and which languages are configured. */
  configure(instance: InstanceLimits, maxBatch: number) {
    this.instance = instance;
    this.maxBatch = Math.max(1, maxBatch);
  }

  get instanceLimits(): InstanceLimits {
    return this.instance;
  }

  async loadProfiles(): Promise<void> {
    this.profiles = new Map((await repo.profiles(this.d.db)).map((p) => [p.languageKey, p]));
  }

  // ---------------- entry points ----------------

  /** judge-submit job. Idempotent: only the first call moves the submission out of `queued`. */
  async start(submissionId: string): Promise<void> {
    const sub = await withTransaction(this.d.db, (tx) => repo.claim(tx, submissionId));
    if (sub) await this.begin(sub);
  }

  /** Degraded mode: claim and start the oldest queued submission. Returns false when none is waiting. */
  async startNextQueued(olderThanSec = 2): Promise<boolean> {
    const sub = await withTransaction(this.d.db, (tx) => repo.claimNextQueued(tx, olderThanSec));
    if (!sub) return false;
    await this.begin(sub);
    return true;
  }

  /**
   * Degraded mode: one sync without a poll job. The position in the poll schedule comes from the
   * time since the current stage started, so "give up after ~5 min" still holds.
   */
  async syncWithoutQueue(submissionId: string): Promise<void> {
    const runs = await repo.runs(this.d.db, submissionId);
    if (!runs.length) return; // just claimed elsewhere; its runs are being created
    const stageStart = Math.max(0, ...runs.map((r) => r.createdAt.getTime()));
    await this.sync(submissionId, pollIndex(Date.now() - stageStart, POLL_DELAYS_MS[this.d.mode]));
  }

  private async begin(sub: SubmissionRow): Promise<void> {
    const spec = await this.d.problems.spec(sub.problemId);
    if (!spec || !spec.files.length) return this.fail(sub.id, 'Problem is unavailable');
    if (spec.version !== sub.problemVersion) {
      await repo.updateSubmission(this.d.db, sub.id, { problemVersion: spec.version });
    }
    const files = this.stageFiles(spec, sub.mode, 1);
    await withTransaction(this.d.db, async (tx) => {
      await repo.insertRuns(tx, [
        ...files.map((f) => ({
          id: newId(),
          submissionId: sub.id,
          stage: 1,
          fileOrdinal: f.ordinal,
          attempt: 1,
        })),
        ...(sub.customInput !== null
          ? [{ id: newId(), submissionId: sub.id, stage: 1, fileOrdinal: CUSTOM_INPUT, attempt: 1 }]
          : []),
      ]);
      await this.emitProgress(tx, sub, 1);
    });
    this.d.afterCommit?.();
    await this.sync(sub.id, 0);
  }

  /**
   * judge-poll job (also the first dispatch): send pending runs, fetch submitted ones, aggregate,
   * and schedule the next poll. Gives up after the poll schedule with IE for unfinished runs.
   */
  async sync(submissionId: string, n: number): Promise<void> {
    const sub = await repo.findSubmission(this.d.db, submissionId);
    if (!sub || sub.status !== 'running') return;

    try {
      await this.dispatchPending(sub);
    } catch (err) {
      this.d.logger.warn({ err, submissionId }, 'dispatch to Judge0 failed; will retry');
    }

    const submitted = (await repo.runs(this.d.db, submissionId)).filter((r) => r.status === 'submitted');
    if (submitted.length) {
      try {
        const results = await this.d.executor.fetchBatch(submitted.map((r) => r.judge0Token!));
        for (const res of results) {
          const run = submitted.find((r) => r.judge0Token === res.token);
          if (run && isFinalStatus(res.statusId)) await repo.recordResult(this.d.db, run.id, res);
        }
      } catch (err) {
        this.d.logger.warn({ err, submissionId }, 'polling Judge0 failed; will retry');
      }
    }
    await this.aggregate(submissionId);

    const after = await repo.findSubmission(this.d.db, submissionId);
    if (after?.status !== 'running') return;
    const runs = await repo.runs(this.d.db, submissionId);
    const open = runs.filter((r) => !finished(r));
    if (!open.length) return;
    const delays = POLL_DELAYS_MS[this.d.mode];
    if (n >= delays.length) {
      for (const r of open)
        await repo.recordResult(this.d.db, r.id, failedResult('No result from the judge in time'), true);
      await this.aggregate(submissionId);
      return;
    }
    // Redis down: the degraded loop polls instead (plan §18.1); don't wait on a dead connection.
    if (this.d.queueHealthy?.() === false) return;
    // the job id includes the run count, so a new stage restarts the schedule without colliding
    await withTimeout(
      this.d.pollQueue.add(
        'sync',
        { submissionId, n: n + 1 },
        { jobId: `poll-${submissionId}-${runs.length}-${n + 1}`, delay: delays[n]! },
      ),
      2000,
    ).catch((err: unknown) =>
      this.d.logger.warn({ err, submissionId }, 'could not schedule the next poll; the sweeper will'),
    );
  }

  /** PUT /api/v1/hooks/judge0/:runId?sig= — Judge0 calls this when a run finishes (callback mode). */
  async onCallback(runId: string, sig: string, body: unknown): Promise<'ok' | 'rejected'> {
    if (!this.validSignature(runId, sig)) return 'rejected';
    const run = await repo.findRun(this.d.db, runId);
    let result: RunResult & { token: string };
    try {
      result = normalizeResult(body, true);
    } catch {
      return 'rejected';
    }
    if (!run || run.judge0Token !== result.token) return 'rejected';
    if (!isFinalStatus(result.statusId)) return 'ok';
    await repo.recordResult(this.d.db, run.id, result);
    await this.aggregate(run.submissionId);
    return 'ok';
  }

  signature(runId: string): string {
    return createHmac('sha256', this.d.callbackSecret ?? '')
      .update(runId)
      .digest('base64url');
  }

  // ---------------- internals ----------------

  private validSignature(runId: string, sig: string): boolean {
    if (!this.d.callbackSecret) return false;
    const want = Buffer.from(this.signature(runId));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private stageFiles(spec: Spec, mode: SubmissionRow['mode'], stage: number): SpecFile[] {
    // calibration needs every file's time: one stage, no fail-fast
    if (mode === 'calibrate') return stage === 1 ? spec.files : [];
    if (mode === 'run') return stage === 1 ? spec.files.filter((f) => f.kind === 'sample') : [];
    const first = spec.files.filter((f) => f.kind !== 'large');
    if (!first.length) return stage === 1 ? spec.files : [];
    return stage === 1 ? first : spec.files.filter((f) => f.kind === 'large');
  }

  private limitsFor(spec: Spec, file: SpecFile, lang: string, overrideMs?: number | null): RequestLimits {
    const p = this.profiles.get(lang);
    const factor = Number(p?.defaultTimeFactor ?? 1);
    return requestLimits({
      // calibration measures with its own limit; everything else follows the drift factor
      cpuLimitMs:
        overrideMs ??
        Math.round(
          (file.cpuLimitMs[lang as LanguageKey] ?? DEFAULT_CPU_MS * factor) * (this.d.driftFactor?.() ?? 1),
        ),
      memoryLimitKb: spec.memoryLimitKb,
      outputLimitKb: spec.outputLimitKb,
      lang: { memOverheadKb: p?.memOverheadKb ?? 0, maxProcesses: p?.maxProcesses ?? JUDGE0_PROCESSES },
      instance: this.instance,
    });
  }

  /** The file a run executes (file 0 = custom input, limited like the first sample). */
  private fileOf(spec: Spec, ordinal: number): SpecFile {
    return ordinal === CUSTOM_INPUT
      ? (spec.files.find((f) => f.kind === 'sample') ?? spec.files[0]!)
      : spec.files.find((f) => f.ordinal === ordinal)!;
  }

  /** Send every pending run to Judge0 and persist the tokens immediately. */
  private async dispatchPending(sub: SubmissionRow): Promise<number> {
    const pending = (await repo.runs(this.d.db, sub.id)).filter((r) => r.status === 'pending');
    if (!pending.length) return 0;
    const spec = await this.d.problems.spec(sub.problemId);
    if (!spec) throw new Error('problem spec unavailable');
    if (!this.profiles.has(sub.languageKey)) await this.loadProfiles();
    const profile = this.profiles.get(sub.languageKey);
    if (!profile) throw new Error(`language ${sub.languageKey} is not configured`);

    const reqs = await Promise.all(
      pending.map(async (run) => {
        const file = this.fileOf(spec, run.fileOrdinal);
        const stdin =
          run.fileOrdinal === CUSTOM_INPUT
            ? (sub.customInput ?? '')
            : await this.d.problems.text(file.inputUrl);
        return {
          languageId: profile.judge0LanguageId,
          sourceCode: sub.code,
          stdin,
          limits: this.limitsFor(spec, file, sub.languageKey, sub.cpuLimitOverrideMs),
          ...(this.d.mode === 'callback' && this.d.callbackBaseUrl
            ? {
                callbackUrl: `${this.d.callbackBaseUrl.replace(/\/$/, '')}/api/v1/hooks/judge0/${run.id}?sig=${this.signature(run.id)}`,
              }
            : {}),
        };
      }),
    );

    // Counted like RapidAPI does: one per batch request. Intake kept headroom for whole
    // submissions, so continuing one may overdraw slightly.
    await repo.reserveCalls(this.d.db, requestsFor(pending.length, this.maxBatch), this.d.dailyBudget, true);
    for (let i = 0; i < pending.length; i += this.maxBatch) {
      const chunk = pending.slice(i, i + this.maxBatch);
      const tokens = await this.d.executor.submitBatch(reqs.slice(i, i + this.maxBatch));
      for (const [j, run] of chunk.entries()) {
        const token = tokens[j];
        if (token) await repo.markSubmitted(this.d.db, run.id, token);
        else await repo.recordResult(this.d.db, run.id, failedResult('The judge rejected this run'), true);
      }
    }
    return pending.length;
  }

  /**
   * Decide what happens next once results arrive (plan §14.4 `aggregate`). Runs under a lock on the
   * submission row, so a callback and a poll delivering at the same moment can't both act.
   */
  async aggregate(submissionId: string): Promise<void> {
    let dispatch = false;
    await withTransaction(this.d.db, async (tx) => {
      const sub = await repo.findSubmission(tx, submissionId, { forUpdate: true });
      if (!sub || sub.status !== 'running') return;
      const spec = await this.d.problems.spec(sub.problemId);
      if (!spec)
        return void (await this.finalizeTx(tx, sub, { verdict: 'IE', message: 'Problem is unavailable' }));

      const latest = latestRuns(await repo.runs(tx, submissionId));
      const custom = latest.get(CUSTOM_INPUT);
      if (custom && !finished(custom)) return;

      const outcome = async (r: JudgeRunRow): Promise<FileOutcome | undefined> => {
        if (!finished(r)) return undefined;
        const file = this.fileOf(spec, r.fileOrdinal);
        const fileSpec = await loadFileSpec(this.d.problems, file);
        return judgeFile(
          resultFromRow(r),
          fileSpec,
          this.limitsFor(spec, file, sub.languageKey, sub.cpuLimitOverrideMs),
          spec.checker,
          r.attempt,
        );
      };
      const judged = [...latest.values()].filter((r) => r.fileOrdinal !== CUSTOM_INPUT);
      const current = judged.filter((r) => r.stage === sub.stage);
      const previous = judged.filter((r) => r.stage < sub.stage);

      const measuring = sub.mode === 'calibrate';
      const decision = decide({
        files: await Promise.all(
          current.map(async (r) => {
            const o = await outcome(r);
            return { ordinal: r.fileOrdinal, outcome: o && measuring ? { ...o, nearMiss: false } : o };
          }),
        ),
        previous: (await Promise.all(previous.map(outcome))).filter((o): o is FileOutcome => !!o),
        hasNextStage: sub.stage === 1 && this.stageFiles(spec, sub.mode, 2).length > 0,
      });

      switch (decision.kind) {
        case 'wait':
          return;
        case 'rerun': {
          const prev = latest.get(decision.ordinal)!;
          await repo.insertRuns(tx, [
            {
              id: newId(),
              submissionId,
              stage: sub.stage,
              fileOrdinal: decision.ordinal,
              attempt: prev.attempt + 1,
            },
          ]);
          dispatch = true;
          return;
        }
        case 'next-stage': {
          await repo.updateSubmission(tx, submissionId, { stage: 2 });
          await repo.insertRuns(
            tx,
            this.stageFiles(spec, sub.mode, 2).map((f) => ({
              id: newId(),
              submissionId,
              stage: 2,
              fileOrdinal: f.ordinal,
              attempt: 1,
            })),
          );
          await this.emitProgress(tx, sub, 2);
          dispatch = true;
          return;
        }
        case 'final': {
          const failed =
            decision.failedOrdinal === null ? undefined : this.fileOf(spec, decision.failedOrdinal);
          await this.finalizeTx(tx, sub, {
            verdict: decision.verdict,
            failedFile: decision.failedOrdinal,
            failedKind: failed?.kind ?? null,
            failedCase: decision.failedCase,
            maxCpuMs: decision.maxCpuMs,
            maxMemKb: decision.maxMemKb,
            message: decision.message,
          });
        }
      }
    });
    this.d.afterCommit?.();
    if (dispatch) await this.sync(submissionId, 0);
  }

  /** Latest outcome per file (calibration report). Undefined outcome = not finished. */
  async fileOutcomes(
    sub: SubmissionRow,
  ): Promise<{ ordinal: number; kind: SpecFile['kind']; outcome?: FileOutcome }[]> {
    const spec = await this.d.problems.spec(sub.problemId);
    if (!spec) return [];
    const latest = latestRuns(await repo.runs(this.d.db, sub.id));
    return Promise.all(
      spec.files.map(async (file) => {
        const r = latest.get(file.ordinal);
        if (!r || !finished(r)) return { ordinal: file.ordinal, kind: file.kind };
        const fileSpec = await loadFileSpec(this.d.problems, file);
        const limits = this.limitsFor(spec, file, sub.languageKey, sub.cpuLimitOverrideMs);
        return {
          ordinal: file.ordinal,
          kind: file.kind,
          outcome: judgeFile(resultFromRow(r), fileSpec, limits, spec.checker, r.attempt),
        };
      }),
    );
  }

  /** The CPU limit really used for an override (capped by the instance). */
  effectiveCpuMs(overrideMs: number): number {
    return Math.min(overrideMs, this.instance.maxCpuSec * 1000);
  }

  private async fail(submissionId: string, message: string): Promise<void> {
    await withTransaction(this.d.db, async (tx) => {
      const sub = await repo.findSubmission(tx, submissionId, { forUpdate: true });
      if (sub?.status === 'running') await this.finalizeTx(tx, sub, { verdict: 'IE', message });
    });
    this.d.afterCommit?.();
  }

  private async finalizeTx(tx: Tx, sub: SubmissionRow, patch: Partial<SubmissionRow>): Promise<void> {
    const done = await repo.finalize(tx, sub.id, patch);
    if (!done || done.mode === 'calibrate') return; // internal runs: no user-facing events
    verdicts.inc({ mode: done.mode, verdict: done.verdict ?? 'IE', cached: String(done.fromCache) });
    if (done.judgedAt) {
      judgeLatency.observe(
        { mode: done.mode },
        (done.judgedAt.getTime() - done.submittedAt.getTime()) / 1000,
      );
    }
    await this.d.outbox.add(tx, judgeEvents.submissionJudgedV1, {
      key: done.matchId ?? done.id,
      recipients: [done.userId],
      data: {
        submissionId: done.id,
        matchId: done.matchId,
        userId: done.userId,
        problemId: done.problemId,
        mode: done.mode,
        verdict: done.verdict!,
        failedFile: done.failedFile,
        failedCase: done.failedCase,
        maxCpuMs: done.maxCpuMs,
        maxMemKb: done.maxMemKb,
        fromCache: done.fromCache,
        submittedAt: done.submittedAt.toISOString(),
        judgedAt: done.judgedAt!.toISOString(),
      },
    });
  }

  private async emitProgress(tx: Tx, sub: SubmissionRow, stage: number): Promise<void> {
    if (sub.mode === 'calibrate') return;
    await this.d.outbox.add(tx, judgeEvents.submissionProgressV1, {
      key: sub.matchId ?? sub.id,
      recipients: [sub.userId],
      data: {
        submissionId: sub.id,
        matchId: sub.matchId,
        userId: sub.userId,
        problemId: sub.problemId,
        mode: sub.mode,
        stage,
        status: 'running',
      },
    });
  }
}
