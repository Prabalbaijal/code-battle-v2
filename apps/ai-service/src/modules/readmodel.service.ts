import type { battleEvents, EventData, judgeEvents, problemEvents } from '@cb/contracts';
import type { Db, Tx } from '@cb/db';
import { and, eq, sql } from 'drizzle-orm';
import { aiMatches, aiProblems, aiSubmissions, type AiMatchRow } from '../db/schema.js';
import { enqueueTask } from '../lib/tasks.js';

/**
 * Local copies of other services' facts, built from their events (plan §5.1 #6: no service reads
 * another's database). Every handler runs inside the consumer's inbox transaction, so a redelivered
 * event changes nothing. Background work (ingestion, integrity checks) is enqueued in the same
 * transaction, so it can't be lost or doubled.
 */
export class ReadModel {
  constructor(private readonly db: Db) {}

  async onProblemPublished(tx: Tx, e: EventData<typeof problemEvents.problemPublishedV1>) {
    await tx
      .insert(aiProblems)
      .values({
        problemId: e.problemId,
        slug: e.slug,
        difficulty: e.difficulty,
        tags: e.tags,
        version: e.version,
        status: 'published',
      })
      .onConflictDoUpdate({
        target: aiProblems.problemId,
        set: {
          slug: e.slug,
          difficulty: e.difficulty,
          tags: e.tags,
          version: e.version,
          status: 'published',
          updatedAt: sql`now()`,
        },
        setWhere: sql`${aiProblems.version} <= ${e.version}`,
      });
    await enqueueTask(
      tx,
      'ingest_problem',
      e.problemId,
      { problemId: e.problemId, slug: e.slug },
      { replace: true },
    );
  }

  async onProblemUpdated(tx: Tx, e: EventData<typeof problemEvents.problemUpdatedV1>) {
    const [row] = await tx
      .update(aiProblems)
      .set({ slug: e.slug, version: e.version, status: e.status, updatedAt: sql`now()` })
      .where(and(eq(aiProblems.problemId, e.problemId), sql`${aiProblems.version} <= ${e.version}`))
      .returning();
    if (!row) return; // never published yet, or an older event
    // a new statement, or the problem left the catalog: the tutor's copy follows
    if (e.change === 'statement' || e.change === 'status') {
      await enqueueTask(
        tx,
        'ingest_problem',
        e.problemId,
        { problemId: e.problemId, slug: e.slug },
        { replace: true },
      );
    }
  }

  async onMatchStarted(tx: Tx, e: EventData<typeof battleEvents.matchStartedV1>) {
    await tx
      .insert(aiMatches)
      .values({
        matchId: e.matchId,
        problemId: e.problemId,
        userIds: e.userIds,
        status: 'in_progress',
        startedAt: new Date(e.startedAt),
        endsAt: new Date(e.endsAt),
      })
      .onConflictDoNothing();
  }

  async onMatchCompleted(tx: Tx, e: EventData<typeof battleEvents.matchCompletedV1>) {
    await tx
      .insert(aiMatches)
      .values({
        matchId: e.matchId,
        problemId: e.problemId,
        userIds: e.userIds,
        status: 'completed',
        winnerId: e.winnerId,
        endReason: e.endReason,
        startedAt: new Date(e.startedAt),
        endedAt: new Date(e.endedAt),
      })
      .onConflictDoUpdate({
        target: aiMatches.matchId,
        set: {
          status: 'completed',
          winnerId: e.winnerId,
          endReason: e.endReason,
          endedAt: new Date(e.endedAt),
        },
      });
    // anti-cheat runs after every finished match (plan §22.2 #6), a minute later so the last
    // verdicts have certainly reached the judge's tables
    await enqueueTask(tx, 'integrity', e.matchId, { matchId: e.matchId }, { delayMs: 60_000 });
  }

  async onMatchAborted(tx: Tx, e: EventData<typeof battleEvents.matchAbortedV1>) {
    await tx
      .update(aiMatches)
      .set({ status: 'aborted', endedAt: new Date() })
      .where(eq(aiMatches.matchId, e.matchId));
  }

  async onSubmissionJudged(tx: Tx, e: EventData<typeof judgeEvents.submissionJudgedV1>) {
    if (e.mode !== 'submit') return;
    await tx
      .insert(aiSubmissions)
      .values({
        submissionId: e.submissionId,
        userId: e.userId,
        problemId: e.problemId,
        matchId: e.matchId,
        verdict: e.verdict,
        judgedAt: new Date(e.judgedAt),
      })
      .onConflictDoNothing();
  }

  // ---- reads ----

  async match(matchId: string): Promise<AiMatchRow | undefined> {
    const [m] = await this.db.select().from(aiMatches).where(eq(aiMatches.matchId, matchId));
    return m;
  }

  /** A running match of this player, if any: the tutor stays quiet during a battle. */
  async activeMatch(userId: string): Promise<AiMatchRow | undefined> {
    const [m] = await this.db
      .select()
      .from(aiMatches)
      .where(
        and(
          eq(aiMatches.status, 'in_progress'),
          sql`${userId}::uuid = any(${aiMatches.userIds})`,
          // a lost completion event mustn't block the tutor forever
          sql`coalesce(${aiMatches.endsAt}, ${aiMatches.startedAt} + interval '40 minutes') > now() - interval '15 minutes'`,
        ),
      )
      .limit(1);
    return m;
  }

  /** Has this player met this problem in a match (so hints and tutoring about it are fair game)? */
  async playedProblem(userId: string, problemId: string): Promise<AiMatchRow | undefined> {
    const [m] = await this.db
      .select()
      .from(aiMatches)
      .where(and(eq(aiMatches.problemId, problemId), sql`${userId}::uuid = any(${aiMatches.userIds})`))
      .orderBy(sql`${aiMatches.startedAt} desc`)
      .limit(1);
    return m;
  }

  async problem(problemId: string) {
    const [p] = await this.db.select().from(aiProblems).where(eq(aiProblems.problemId, problemId));
    return p;
  }
}
