import type { Executor } from '@cb/db';
import type { RunResult } from '@cb/judge-core';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  judgeBudgetDaily,
  judgeRuns,
  languageProfiles,
  submissions,
  type JudgeRunRow,
  type LanguageProfileRow,
  type SubmissionRow,
} from '../../db/schema.js';

const MAX_STORED = 64 * 1024;
const cut = (s: string | null, max = MAX_STORED) => (s && s.length > max ? s.slice(0, max) : s);
const today = sql`(now() at time zone 'utc')::date`;

/** SQL for submissions, judge runs, the daily budget and language profiles. */
export const judgingRepository = {
  // ---- submissions ----
  async insertSubmission(ex: Executor, row: typeof submissions.$inferInsert): Promise<SubmissionRow> {
    const [s] = await ex.insert(submissions).values(row).returning();
    return s!;
  },

  async findSubmission(
    ex: Executor,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<SubmissionRow | undefined> {
    const q = ex.select().from(submissions).where(eq(submissions.id, id));
    const [s] = opts.forUpdate ? await q.for('update') : await q;
    return s;
  },

  /** queued → running; returns undefined if another worker (or a retry) already took it. */
  async claim(ex: Executor, id: string): Promise<SubmissionRow | undefined> {
    const [s] = await ex
      .update(submissions)
      .set({ status: 'running', stage: 1 })
      .where(and(eq(submissions.id, id), eq(submissions.status, 'queued')))
      .returning();
    return s;
  },

  /**
   * Degraded mode (plan §18.1): Postgres as the backup queue. Claims the oldest queued submission
   * that BullMQ hasn't picked up; SKIP LOCKED lets several workers claim without waiting on each other.
   */
  async claimNextQueued(ex: Executor, olderThanSec: number): Promise<SubmissionRow | undefined> {
    const { rows } = await ex.execute<{ id: string }>(
      sql`update submissions set status = 'running', stage = 1
          where id = (
            select id from submissions
            where status = 'queued' and submitted_at < now() - make_interval(secs => ${olderThanSec})
            order by submitted_at
            for update skip locked
            limit 1
          )
          returning id`,
    );
    const id = rows[0]?.id;
    return id ? this.findSubmission(ex, id) : undefined;
  },

  async runningSubmissionIds(ex: Executor, limit: number): Promise<string[]> {
    const rows = await ex
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.status, 'running'))
      .orderBy(submissions.submittedAt)
      .limit(limit);
    return rows.map((r) => r.id);
  },

  async updateSubmission(
    ex: Executor,
    id: string,
    patch: Partial<typeof submissions.$inferInsert>,
  ): Promise<void> {
    await ex.update(submissions).set(patch).where(eq(submissions.id, id));
  },

  /** Finalize exactly once (running → done). */
  async finalize(
    ex: Executor,
    id: string,
    patch: Partial<typeof submissions.$inferInsert>,
  ): Promise<SubmissionRow | undefined> {
    const [s] = await ex
      .update(submissions)
      .set({ ...patch, status: 'done', judgedAt: sql`now()` })
      .where(and(eq(submissions.id, id), eq(submissions.status, 'running')))
      .returning();
    return s;
  },

  /** Verdict cache (plan §14.6): an identical submit on the same problem version, already judged. */
  async cachedVerdict(
    ex: Executor,
    problemId: string,
    version: number,
    codeHash: string,
  ): Promise<SubmissionRow | undefined> {
    const [s] = await ex
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.problemId, problemId),
          eq(submissions.problemVersion, version),
          eq(submissions.codeHash, codeHash),
          eq(submissions.status, 'done'),
          eq(submissions.mode, 'submit'),
          sql`${submissions.verdict} <> 'IE'`,
        ),
      )
      .limit(1);
    return s;
  },

  async countMatchSubmits(ex: Executor, userId: string, matchId: string): Promise<number> {
    const [r] = await ex
      .select({ n: sql<number>`count(*)::int` })
      .from(submissions)
      .where(
        and(eq(submissions.userId, userId), eq(submissions.matchId, matchId), eq(submissions.mode, 'submit')),
      );
    return r?.n ?? 0;
  },

  async lastSubmitHash(
    ex: Executor,
    userId: string,
    problemId: string,
    matchId: string | null,
  ): Promise<string | undefined> {
    const [r] = await ex
      .select({ h: submissions.codeHash })
      .from(submissions)
      .where(
        and(
          eq(submissions.userId, userId),
          eq(submissions.problemId, problemId),
          eq(submissions.mode, 'submit'),
          matchId ? eq(submissions.matchId, matchId) : sql`${submissions.matchId} is null`,
        ),
      )
      .orderBy(desc(submissions.submittedAt))
      .limit(1);
    return r?.h;
  },

  async listForUser(
    ex: Executor,
    userId: string,
    filter: { problemId?: string; matchId?: string },
    limit: number,
  ) {
    return ex
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.userId, userId),
          filter.problemId ? eq(submissions.problemId, filter.problemId) : undefined,
          filter.matchId ? eq(submissions.matchId, filter.matchId) : undefined,
        ),
      )
      .orderBy(desc(submissions.submittedAt))
      .limit(limit);
  },

  // ---- runs ----
  /** Idempotent: (submission, file, attempt) is unique, so a retried job can't double-create runs. */
  async insertRuns(
    ex: Executor,
    rows: { id: string; submissionId: string; stage: number; fileOrdinal: number; attempt: number }[],
  ): Promise<void> {
    if (!rows.length) return;
    await ex
      .insert(judgeRuns)
      .values(rows.map((r) => ({ ...r, status: 'pending' as const })))
      .onConflictDoNothing();
  },

  async runs(ex: Executor, submissionId: string): Promise<JudgeRunRow[]> {
    return ex
      .select()
      .from(judgeRuns)
      .where(eq(judgeRuns.submissionId, submissionId))
      .orderBy(asc(judgeRuns.fileOrdinal), asc(judgeRuns.attempt));
  },

  async findRun(ex: Executor, id: string): Promise<JudgeRunRow | undefined> {
    const [r] = await ex.select().from(judgeRuns).where(eq(judgeRuns.id, id));
    return r;
  },

  async markSubmitted(ex: Executor, id: string, token: string): Promise<void> {
    await ex
      .update(judgeRuns)
      .set({ status: 'submitted', judge0Token: token, submittedAt: sql`now()` })
      .where(and(eq(judgeRuns.id, id), eq(judgeRuns.status, 'pending')));
  },

  /** Store a final Judge0 result once (callback and poll may both deliver it). */
  async recordResult(ex: Executor, id: string, r: RunResult, failed = false): Promise<boolean> {
    const rows = await ex
      .update(judgeRuns)
      .set({
        status: failed ? 'failed' : 'done',
        judge0StatusId: r.statusId,
        cpuMs: r.time === null ? null : Math.round(r.time * 1000),
        wallMs: r.wallTime === null ? null : Math.round(r.wallTime * 1000),
        memKb: r.memoryKb,
        // the checker needs the whole output (≤ the problem's output limit, max 4 MB on Judge0)
        stdoutTrunc: cut(r.stdout, 4 * 1024 * 1024),
        stderrTrunc: cut(r.stderr, 8192),
        compileOutput: cut(r.compileOutput, 8192),
        message: cut(r.message, 2048),
        completedAt: sql`now()`,
      })
      .where(and(eq(judgeRuns.id, id), inArray(judgeRuns.status, ['pending', 'submitted'])))
      .returning({ id: judgeRuns.id });
    return rows.length > 0;
  },

  /** Submissions with runs waiting longer than `olderThanSec` (safety net when a poll job got lost). */
  async stuckSubmissions(ex: Executor, olderThanSec: number): Promise<string[]> {
    const rows = await ex
      .selectDistinct({ id: judgeRuns.submissionId })
      .from(judgeRuns)
      .where(
        and(
          inArray(judgeRuns.status, ['pending', 'submitted']),
          sql`${judgeRuns.createdAt} < now() - make_interval(secs => ${olderThanSec})`,
        ),
      )
      .limit(100);
    return rows.map((r) => r.id);
  },

  // ---- budget (plan §14.6) ----
  /**
   * Reserve `n` Judge0 calls for today. Starting a submission must fit the limit; continuing one
   * (stage 2, reruns) may overdraw slightly, since intake already kept headroom.
   */
  async reserveCalls(ex: Executor, n: number, limit: number, overdraft: boolean): Promise<boolean> {
    await ex
      .insert(judgeBudgetDaily)
      .values({ day: sql`${today}` as unknown as string, callsUsed: 0, callsLimit: limit })
      .onConflictDoUpdate({ target: judgeBudgetDaily.day, set: { callsLimit: limit } });
    const r = await ex
      .update(judgeBudgetDaily)
      .set({ callsUsed: sql`${judgeBudgetDaily.callsUsed} + ${n}` })
      .where(
        and(
          sql`${judgeBudgetDaily.day} = ${today}`,
          overdraft ? undefined : sql`${judgeBudgetDaily.callsUsed} + ${n} <= ${judgeBudgetDaily.callsLimit}`,
        ),
      )
      .returning({ used: judgeBudgetDaily.callsUsed });
    return r.length > 0;
  },

  async usage(ex: Executor, limit: number): Promise<{ day: string; used: number; limit: number }> {
    const { rows } = await ex.execute<{ day: string; used: number }>(
      sql`select ${today}::text as day,
                 coalesce((select ${judgeBudgetDaily.callsUsed} from ${judgeBudgetDaily}
                           where ${judgeBudgetDaily.day} = ${today}), 0)::int as used`,
    );
    return { day: rows[0]!.day, used: rows[0]!.used, limit };
  },

  // ---- language profiles ----
  async profiles(ex: Executor): Promise<LanguageProfileRow[]> {
    return ex.select().from(languageProfiles);
  },

  async upsertProfiles(ex: Executor, rows: (typeof languageProfiles.$inferInsert)[]): Promise<void> {
    for (const row of rows) {
      await ex
        .insert(languageProfiles)
        .values(row)
        .onConflictDoUpdate({
          target: languageProfiles.languageKey,
          set: { judge0LanguageId: row.judge0LanguageId, name: row.name },
        });
    }
  },
};
