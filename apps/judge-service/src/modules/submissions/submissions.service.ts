import type { AuthUser } from '@cb/auth';
import { judgeEvents, type Capacity, type CreateSubmissionBody, type SubmissionView } from '@cb/contracts';
import { withTransaction, type Db, type Tx } from '@cb/db';
import { AppError, badRequest, conflict, notFound } from '@cb/errors';
import type { OutboxWriter } from '@cb/events';
import { newId } from '@cb/ids';
import { addJobToOutbox } from '@cb/queue';
import { createHash } from 'node:crypto';
import type { JudgeRunRow, SubmissionRow } from '../../db/schema.js';
import type { CodeExecutor } from '../../judge0/executor.js';
import type { ProblemSource } from '../../problems/problem-source.js';
import { QUEUES } from '../../queues.js';
import { judgingRepository as repo } from '../judging/judging.repository.js';

export interface SubmissionServiceDeps {
  db: Db;
  outbox: OutboxWriter;
  problems: ProblemSource;
  executor: CodeExecutor;
  dailyBudget: number;
  matchReserveCalls: number;
  maxSubmitsPerMatch: number;
  afterCommit?: () => void;
}

/** sha256(language | code with normalised line endings and trailing whitespace) (plan §9.5). */
export function codeHash(languageKey: string, code: string): string {
  const normalised = code
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
  return createHash('sha256').update(`${languageKey}|${normalised}`).digest('hex');
}

/** Calibration runs belong to the system user and never reach these user-facing paths. */
export function userMode(mode: SubmissionRow['mode']): 'submit' | 'run' {
  if (mode === 'calibrate') throw new Error('calibration runs are internal');
  return mode;
}

const trimOut = (s: string | null, max = 4096) => (s && s.length > max ? `${s.slice(0, max)}…` : s);

export function toView(s: SubmissionRow, custom?: JudgeRunRow): SubmissionView {
  return {
    id: s.id,
    mode: userMode(s.mode),
    problemId: s.problemId,
    matchId: s.matchId,
    languageKey: s.languageKey as SubmissionView['languageKey'],
    status: s.status,
    verdict: s.verdict,
    failedFile: s.failedFile !== null && s.failedKind ? { ordinal: s.failedFile, kind: s.failedKind } : null,
    failedCase: s.failedCase,
    maxCpuMs: s.maxCpuMs,
    maxMemKb: s.maxMemKb,
    message: s.message,
    fromCache: s.fromCache,
    custom: custom
      ? {
          stdout: trimOut(custom.stdoutTrunc),
          stderr: trimOut(custom.stderrTrunc ?? custom.compileOutput),
          verdict: custom.status === 'failed' ? 'IE' : null,
        }
      : null,
    submittedAt: s.submittedAt.toISOString(),
    judgedAt: s.judgedAt?.toISOString() ?? null,
  };
}

/**
 * Intake (plan §14.6): every gate runs before any Judge0 quota is spent — language, problem status,
 * per-match cap, "code must change", verdict cache (0 calls), then the daily budget and breaker.
 */
export class SubmissionService {
  constructor(private readonly d: SubmissionServiceDeps) {}

  async capacity(): Promise<Capacity> {
    const u = await repo.usage(this.d.db, this.d.dailyBudget);
    return { ...u, remaining: Math.max(0, u.limit - u.used), breaker: this.d.executor.breakerState };
  }

  async create(
    user: AuthUser,
    body: CreateSubmissionBody,
  ): Promise<{ submissionId: string; status: SubmissionRow['status'] }> {
    const profiles = await repo.profiles(this.d.db);
    if (!profiles.some((p) => p.languageKey === body.languageKey && p.enabled)) {
      throw badRequest(`${body.languageKey} is not available right now`);
    }

    const spec = await this.d.problems.spec(body.problemId);
    const canSeeDrafts = user.role === 'problem_setter' || user.role === 'admin';
    if (!spec || (spec.status !== 'published' && !canSeeDrafts)) throw notFound('Problem');

    const matchId = body.matchId ?? null;
    if (body.mode === 'submit' && matchId) {
      const used = await repo.countMatchSubmits(this.d.db, user.userId, matchId);
      if (used >= this.d.maxSubmitsPerMatch) {
        throw new AppError(
          'SUBMISSION_LIMIT_REACHED',
          429,
          `At most ${this.d.maxSubmitsPerMatch} submissions per match`,
        );
      }
    }

    const hash = codeHash(body.languageKey, body.code);
    if (body.mode === 'submit') {
      if ((await repo.lastSubmitHash(this.d.db, user.userId, body.problemId, matchId)) === hash) {
        throw conflict('CODE_UNCHANGED', 'This is the same code as your last submission');
      }
      const cached = await repo.cachedVerdict(this.d.db, body.problemId, spec.version, hash);
      if (cached) return this.fromCache(user, body, spec.version, hash, cached);
    }

    // Admission: practice can't use the reserve kept for matches; the breaker refuses everything.
    const cap = await this.capacity();
    const cost = body.mode === 'submit' ? spec.files.length : 1 + (body.customInput !== undefined ? 1 : 0);
    const floor = matchId ? 0 : this.d.matchReserveCalls;
    if (cap.breaker === 'open' || cap.remaining - cost < floor) {
      throw new AppError('JUDGE_AT_CAPACITY', 503, 'The judge is busy right now. Try again later.', {
        expose: true,
        details: { breaker: cap.breaker, remaining: cap.remaining },
      });
    }

    const id = newId();
    const row = await withTransaction(this.d.db, async (tx) => {
      const s = await repo.insertSubmission(tx, {
        id,
        userId: user.userId,
        matchId,
        problemId: body.problemId,
        problemVersion: spec.version,
        mode: body.mode,
        languageKey: body.languageKey,
        code: body.code,
        codeHash: hash,
        customInput: body.customInput ?? null,
        status: 'queued',
      });
      await addJobToOutbox(tx, {
        queue: QUEUES.submit,
        jobId: `submit-${id}`,
        name: 'submit',
        data: { submissionId: id },
        // Runs wait behind Submits (plan §10.4: judge-run has low priority).
        priority: body.mode === 'submit' ? 1 : 10,
      });
      await this.emitCreated(tx, s);
      return s;
    });
    this.d.afterCommit?.();
    return { submissionId: row.id, status: row.status };
  }

  /** Identical code on the same problem version was judged before: 0 Judge0 calls. */
  private async fromCache(
    user: AuthUser,
    body: CreateSubmissionBody,
    version: number,
    hash: string,
    cached: SubmissionRow,
  ): Promise<{ submissionId: string; status: SubmissionRow['status'] }> {
    const row = await withTransaction(this.d.db, async (tx) => {
      const s = await repo.insertSubmission(tx, {
        id: newId(),
        userId: user.userId,
        matchId: body.matchId ?? null,
        problemId: body.problemId,
        problemVersion: version,
        mode: 'submit',
        languageKey: body.languageKey,
        code: body.code,
        codeHash: hash,
        status: 'done',
        verdict: cached.verdict,
        failedFile: cached.failedFile,
        failedKind: cached.failedKind,
        failedCase: cached.failedCase,
        maxCpuMs: cached.maxCpuMs,
        maxMemKb: cached.maxMemKb,
        message: cached.message,
        fromCache: true,
        judgedAt: new Date(),
      });
      await this.emitCreated(tx, s);
      await this.d.outbox.add(tx, judgeEvents.submissionJudgedV1, {
        key: s.matchId ?? s.id,
        recipients: [s.userId],
        data: {
          submissionId: s.id,
          matchId: s.matchId,
          userId: s.userId,
          problemId: s.problemId,
          mode: userMode(s.mode),
          verdict: s.verdict!,
          failedFile: s.failedFile,
          failedCase: s.failedCase,
          maxCpuMs: s.maxCpuMs,
          maxMemKb: s.maxMemKb,
          fromCache: true,
          submittedAt: s.submittedAt.toISOString(),
          judgedAt: s.judgedAt!.toISOString(),
        },
      });
      return s;
    });
    this.d.afterCommit?.();
    return { submissionId: row.id, status: row.status };
  }

  /** Owners only (match opponents get verdicts through events, never code). */
  async get(user: AuthUser, id: string): Promise<SubmissionView> {
    const s = await repo.findSubmission(this.d.db, id);
    if (!s || s.userId !== user.userId) throw notFound('Submission');
    const custom =
      s.customInput !== null
        ? (await repo.runs(this.d.db, id)).filter((r) => r.fileOrdinal === 0).at(-1)
        : undefined;
    return toView(s, custom);
  }

  async list(user: AuthUser, filter: { problemId?: string; matchId?: string }): Promise<SubmissionView[]> {
    return (await repo.listForUser(this.d.db, user.userId, filter, 20)).map((s) => toView(s));
  }

  async languages() {
    return (await repo.profiles(this.d.db)).map((p) => ({
      key: p.languageKey as SubmissionView['languageKey'],
      name: p.name,
      enabled: p.enabled,
    }));
  }

  private async emitCreated(tx: Tx, s: SubmissionRow) {
    await this.d.outbox.add(tx, judgeEvents.submissionCreatedV1, {
      key: s.matchId ?? s.id,
      recipients: [s.userId],
      data: {
        submissionId: s.id,
        matchId: s.matchId,
        userId: s.userId,
        problemId: s.problemId,
        mode: userMode(s.mode),
        submittedAt: s.submittedAt.toISOString(),
      },
    });
  }
}
