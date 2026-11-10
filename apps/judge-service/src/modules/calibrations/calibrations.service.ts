import type { CalibrationRequest, CalibrationResult } from '@cb/contracts';
import { isUniqueViolation, withTransaction, type Db } from '@cb/db';
import { AppError, badRequest, notFound } from '@cb/errors';
import { newId } from '@cb/ids';
import { addJobToOutbox } from '@cb/queue';
import { eq } from 'drizzle-orm';
import { submissions, type SubmissionRow } from '../../db/schema.js';
import type { ProblemSource } from '../../problems/problem-source.js';
import { QUEUES } from '../../queues.js';
import { judgingRepository as repo } from '../judging/judging.repository.js';
import type { JudgingService } from '../judging/judging.service.js';
import { codeHash, type SubmissionService } from '../submissions/submissions.service.js';

/** Owner of internal runs (no real user). */
export const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

export interface CalibrationServiceDeps {
  db: Db;
  problems: ProblemSource;
  judging: JudgingService;
  submissions: SubmissionService;
  matchReserveCalls: number;
  afterCommit?: () => void;
}

/**
 * Calibration runs for problem-service (plan §14.7): a reference solution on every file, measured
 * with one generous CPU limit. They use the normal pipeline in `calibrate` mode and the same budget.
 */
export class CalibrationService {
  constructor(private readonly d: CalibrationServiceDeps) {}

  async create(req: CalibrationRequest): Promise<CalibrationResult> {
    const existing = await this.byRequestKey(req.requestKey);
    if (existing) return this.view(existing);

    const spec = await this.d.problems.spec(req.problemId);
    if (!spec) throw notFound('Problem');
    if (!spec.files.length) throw badRequest('Problem has no test files');
    const profiles = await repo.profiles(this.d.db);
    if (!profiles.some((p) => p.languageKey === req.languageKey && p.enabled)) {
      throw badRequest(`${req.languageKey} is not available on this judge`);
    }
    const cap = await this.d.submissions.capacity();
    if (cap.breaker === 'open' || cap.remaining - spec.files.length < this.d.matchReserveCalls) {
      throw new AppError('JUDGE_AT_CAPACITY', 503, 'Not enough judge quota left today to calibrate', {
        expose: true,
      });
    }

    const id = newId();
    try {
      await withTransaction(this.d.db, async (tx) => {
        await repo.insertSubmission(tx, {
          id,
          userId: SYSTEM_USER,
          problemId: req.problemId,
          problemVersion: spec.version,
          mode: 'calibrate',
          languageKey: req.languageKey,
          code: req.code,
          codeHash: codeHash(req.languageKey, req.code),
          status: 'queued',
          cpuLimitOverrideMs: req.cpuLimitMs,
          requestKey: req.requestKey,
        });
        await addJobToOutbox(tx, {
          queue: QUEUES.submit,
          jobId: `submit-${id}`,
          name: 'calibrate',
          data: { submissionId: id },
          priority: 20, // after players' submits and runs
        });
      });
    } catch (err) {
      // the same request raced us: return the winner
      if (isUniqueViolation(err, 'submissions_request_key_key'))
        return this.view((await this.byRequestKey(req.requestKey))!);
      throw err;
    }
    this.d.afterCommit?.();
    return this.view((await repo.findSubmission(this.d.db, id))!);
  }

  async get(id: string): Promise<CalibrationResult> {
    const s = await repo.findSubmission(this.d.db, id);
    if (!s || s.mode !== 'calibrate') throw notFound('Calibration run');
    return this.view(s);
  }

  private async byRequestKey(key: string): Promise<SubmissionRow | undefined> {
    const [s] = await this.d.db.select().from(submissions).where(eq(submissions.requestKey, key));
    return s;
  }

  private async view(s: SubmissionRow): Promise<CalibrationResult> {
    const files = s.status === 'done' ? await this.d.judging.fileOutcomes(s) : [];
    return {
      id: s.id,
      status: s.status,
      problemVersion: s.problemVersion,
      cpuLimitMs: this.d.judging.effectiveCpuMs(s.cpuLimitOverrideMs ?? 0),
      files: files.map((f) => ({
        ordinal: f.ordinal,
        kind: f.kind,
        verdict: f.outcome?.verdict ?? null,
        cpuMs: f.outcome?.cpuMs ?? null,
        memKb: f.outcome?.memKb ?? null,
        failedCase: f.outcome?.failedCase ?? null,
      })),
    };
  }
}
