import type { Executor } from '@cb/db';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  matchProblem,
  problemLanguageLimits,
  problems,
  referenceSolutions,
  testFiles,
  userProblemSeen,
  type LimitRow,
  type ProblemRow,
  type ReferenceSolutionRow,
  type TestFileRow,
} from '../../db/schema.js';

export type NewProblem = typeof problems.$inferInsert;

/** SQL only (plan §9.3). */
export const problemsRepository = {
  async insert(ex: Executor, row: NewProblem): Promise<ProblemRow> {
    const [p] = await ex.insert(problems).values(row).returning();
    return p!;
  },

  async findById(
    ex: Executor,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<ProblemRow | undefined> {
    const q = ex.select().from(problems).where(eq(problems.id, id));
    const [p] = opts.forUpdate ? await q.for('update') : await q;
    return p;
  },

  async findPublishedBySlug(ex: Executor, slug: string): Promise<ProblemRow | undefined> {
    const [p] = await ex
      .select()
      .from(problems)
      .where(and(eq(problems.slug, slug), eq(problems.status, 'published')));
    return p;
  },

  async update(ex: Executor, id: string, patch: Partial<NewProblem>): Promise<ProblemRow> {
    const [p] = await ex
      .update(problems)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(problems.id, id))
      .returning();
    return p!;
  },

  /** Tests or limits changed: new version, calibration void, a published problem goes back to draft. */
  async invalidate(ex: Executor, id: string): Promise<ProblemRow> {
    await ex.delete(problemLanguageLimits).where(eq(problemLanguageLimits.problemId, id));
    const [p] = await ex
      .update(problems)
      .set({
        version: sql`${problems.version} + 1`,
        calibratedAt: null,
        status: sql`case when ${problems.status} = 'published' then 'draft' else ${problems.status} end`,
        updatedAt: sql`now()`,
      })
      .where(eq(problems.id, id))
      .returning();
    return p!;
  },

  async list(ex: Executor, after: { t: string; id: string } | undefined, limit: number) {
    return ex
      .select({
        id: problems.id,
        slug: problems.slug,
        title: problems.title,
        difficulty: problems.difficulty,
        status: problems.status,
        version: problems.version,
        updatedAt: problems.updatedAt,
        ts: sql<string>`${problems.updatedAt}::text`,
      })
      .from(problems)
      .where(
        after
          ? sql`(${problems.updatedAt}, ${problems.id}) < (${after.t}::timestamptz, ${after.id}::uuid)`
          : undefined,
      )
      .orderBy(desc(problems.updatedAt), desc(problems.id))
      .limit(limit);
  },

  // ---- test files, references, limits ----

  async files(ex: Executor, problemId: string): Promise<TestFileRow[]> {
    return ex
      .select()
      .from(testFiles)
      .where(eq(testFiles.problemId, problemId))
      .orderBy(asc(testFiles.ordinal));
  },

  async upsertFile(ex: Executor, row: TestFileRow): Promise<void> {
    await ex
      .insert(testFiles)
      .values(row)
      .onConflictDoUpdate({
        target: [testFiles.problemId, testFiles.ordinal],
        set: {
          kind: row.kind,
          caseCount: row.caseCount,
          inputUri: row.inputUri,
          outputUri: row.outputUri,
          outputCaseLineCounts: row.outputCaseLineCounts,
          inputBytes: row.inputBytes,
          sha256: row.sha256,
        },
      });
  },

  async deleteFile(ex: Executor, problemId: string, ordinal: number): Promise<boolean> {
    const r = await ex
      .delete(testFiles)
      .where(and(eq(testFiles.problemId, problemId), eq(testFiles.ordinal, ordinal)))
      .returning({ o: testFiles.ordinal });
    return r.length > 0;
  },

  async references(ex: Executor, problemId: string): Promise<ReferenceSolutionRow[]> {
    return ex
      .select()
      .from(referenceSolutions)
      .where(eq(referenceSolutions.problemId, problemId))
      .orderBy(asc(referenceSolutions.createdAt));
  },

  async insertReference(
    ex: Executor,
    row: typeof referenceSolutions.$inferInsert,
  ): Promise<ReferenceSolutionRow> {
    const [r] = await ex.insert(referenceSolutions).values(row).returning();
    return r!;
  },

  async deleteReference(ex: Executor, problemId: string, id: string): Promise<boolean> {
    const r = await ex
      .delete(referenceSolutions)
      .where(and(eq(referenceSolutions.problemId, problemId), eq(referenceSolutions.id, id)))
      .returning({ id: referenceSolutions.id });
    return r.length > 0;
  },

  async limits(ex: Executor, problemId: string): Promise<LimitRow[]> {
    return ex.select().from(problemLanguageLimits).where(eq(problemLanguageLimits.problemId, problemId));
  },

  /** Written by calibration (plan §14.7). Replaces every limit of the problem. */
  async replaceLimits(ex: Executor, problemId: string, rows: Omit<LimitRow, 'problemId'>[]): Promise<void> {
    await ex.delete(problemLanguageLimits).where(eq(problemLanguageLimits.problemId, problemId));
    if (rows.length) await ex.insert(problemLanguageLimits).values(rows.map((r) => ({ ...r, problemId })));
  },

  // ---- selection ----

  async findSelection(ex: Executor, matchId: string): Promise<string | undefined> {
    const [r] = await ex.select().from(matchProblem).where(eq(matchProblem.matchId, matchId));
    return r?.problemId;
  },

  /** Returns false if another call already selected for this match (the caller re-reads). */
  async insertSelection(ex: Executor, matchId: string, problemId: string): Promise<boolean> {
    const r = await ex
      .insert(matchProblem)
      .values({ matchId, problemId })
      .onConflictDoNothing()
      .returning({ m: matchProblem.matchId });
    return r.length > 0;
  },

  async markSeen(ex: Executor, userIds: string[], problemId: string): Promise<void> {
    if (!userIds.length) return;
    await ex
      .insert(userProblemSeen)
      .values(userIds.map((userId) => ({ userId, problemId })))
      .onConflictDoNothing();
  },

  /**
   * Random published problem none of the users has seen (plan §9.3): start at a random point on
   * `random_key` and wrap around once.
   */
  async pickUnseen(
    ex: Executor,
    userIds: string[],
    difficulty?: string,
  ): Promise<{ id: string; slug: string } | undefined> {
    const k = Math.random();
    const ids = sql`array[${sql.join(
      userIds.map((u) => sql`${u}::uuid`),
      sql`, `,
    )}]`;
    for (const half of [sql`${problems.randomKey} >= ${k}`, sql`${problems.randomKey} < ${k}`]) {
      const [p] = await ex
        .select({ id: problems.id, slug: problems.slug })
        .from(problems)
        .where(
          and(
            eq(problems.status, 'published'),
            half,
            difficulty ? eq(problems.difficulty, difficulty as ProblemRow['difficulty']) : undefined,
            sql`not exists (select 1 from ${userProblemSeen} s where s.problem_id = ${problems.id} and s.user_id = any(${ids}))`,
          ),
        )
        .orderBy(asc(problems.randomKey))
        .limit(1);
      if (p) return p;
    }
    return undefined;
  },
};
