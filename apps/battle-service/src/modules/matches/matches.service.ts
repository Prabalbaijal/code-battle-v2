import { counter, histogram } from '@cb/metrics';
import {
  battleEvents,
  type judgeEvents,
  type ActiveMatch,
  type EventData,
  type MatchHistoryItem,
  type MatchState,
  type Participation,
  type Player,
} from '@cb/contracts';
import { isUniqueViolation, withTransaction, type Db, type Tx } from '@cb/db';
import { conflict, notFound } from '@cb/errors';
import type { OutboxWriter } from '@cb/events';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { CREATED_STUCK_MS, decide, isOpen, results, TIMEOUT_GRACE_MS } from '@cb/match-rules';
import { addJobToOutbox } from '@cb/queue';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { SelectionError, type ProblemSelector, type UserDirectory } from '../../clients.js';
import {
  challenges,
  matches,
  matchParticipants,
  matchSubmissions,
  userActiveMatch,
  type MatchRow,
} from '../../db/schema.js';
import { QUEUES } from '../../queues.js';

export interface MatchServiceDeps {
  db: Db;
  outbox: OutboxWriter;
  logger: Logger;
  users: UserDirectory;
  problems: ProblemSelector;
  matchDurationSec: number;
  decideCapSec: number;
  afterCommit?: () => void;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const OPEN = ['in_progress', 'deciding'] as const;

/** Why a start failed, in words the UI shows (v1: "no new problems available"). */
function abortReason(err: SelectionError): string {
  return err.code === 'NO_UNSEEN_PROBLEM'
    ? "Couldn't start the match: no new problems are available for you two"
    : "Couldn't start the match right now. Try again in a moment";
}

/**
 * Matches (plan §11.2–11.6). Every state change is a compare-and-set on `matches.status`, so the
 * first writer wins and the loser updates zero rows: no distributed lock anywhere.
 */
/** Plan §19: accept → match started (SLO p95 < 1.5 s), and how matches end. */
const startLatency = histogram(
  'match_start_latency_seconds',
  'Challenge accepted to match started',
  ['outcome'],
  [0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10],
);
const finished = counter('matches_finished_total', 'Matches that ended', ['end_reason']);

export class MatchService {
  constructor(private readonly d: MatchServiceDeps) {}

  // ---------------- start saga (plan §11.2) ----------------

  async accept(me: string, challengeId: string): Promise<{ matchId: string; status: MatchRow['status'] }> {
    const end = startLatency.startTimer();
    // Transaction A: accept, create the match, lock both players.
    const a = await withTransaction(this.d.db, async (tx) => {
      const matchId = newId();
      const [c] = await tx
        .update(challenges)
        .set({ status: 'accepted', matchId, updatedAt: sql`now()` })
        .where(
          and(
            eq(challenges.id, challengeId),
            eq(challenges.toUser, me),
            eq(challenges.status, 'pending'),
            sql`${challenges.expiresAt} > now()`,
          ),
        )
        .returning();
      if (!c) {
        const [existing] = await tx.select().from(challenges).where(eq(challenges.id, challengeId));
        if (!existing || existing.toUser !== me) throw notFound('Challenge');
        // double-click / retried request: same match
        if (existing.status === 'accepted' && existing.matchId)
          return { kind: 'replay' as const, matchId: existing.matchId };
        throw conflict(
          'CHALLENGE_NOT_PENDING',
          existing.status === 'pending'
            ? 'This challenge has expired'
            : `This challenge was ${existing.status}`,
        );
      }
      await tx.insert(matches).values({ id: matchId, status: 'created' });
      try {
        await tx.insert(userActiveMatch).values([
          { userId: c.fromUser, matchId },
          { userId: c.toUser, matchId },
        ]);
      } catch (err) {
        // one of them is already playing (also resolves A→B and B→A accepted together)
        if (isUniqueViolation(err))
          throw conflict('USER_IN_ACTIVE_MATCH', 'One of you is already in a match');
        throw err;
      }
      await this.d.outbox.add(tx, battleEvents.challengeAcceptedV1, {
        key: challengeId,
        recipients: [c.fromUser, c.toUser],
        data: { challengeId, fromUserId: c.fromUser, toUserId: c.toUser, matchId },
      });
      return { kind: 'new' as const, matchId, userIds: [c.fromUser, c.toUser] };
    });
    if (a.kind === 'replay') {
      const [m] = await this.d.db.select().from(matches).where(eq(matches.id, a.matchId));
      return { matchId: a.matchId, status: m?.status ?? 'created' };
    }
    this.d.afterCommit?.();

    // Selection: idempotent by matchId; a failure is compensated.
    let selection;
    try {
      selection = await this.d.problems.select(a.matchId, a.userIds);
    } catch (err) {
      const e = err instanceof SelectionError ? err : new SelectionError('UNKNOWN', String(err));
      this.d.logger.warn({ err, matchId: a.matchId }, 'problem selection failed; aborting the match');
      await this.abort(a.matchId, abortReason(e), ['created']);
      return { matchId: a.matchId, status: 'aborted' };
    }

    // Transaction B: start the clock (server time only).
    const started = await withTransaction(this.d.db, async (tx) => {
      const [m] = await tx
        .update(matches)
        .set({
          status: 'in_progress',
          problemId: selection.problemId,
          problemSlug: selection.slug,
          startedAt: sql`now()`,
          endsAt: sql`now() + make_interval(secs => ${this.d.matchDurationSec})`,
          version: sql`${matches.version} + 1`,
        })
        .where(and(eq(matches.id, a.matchId), eq(matches.status, 'created')))
        .returning();
      if (!m) return undefined; // the reconciler aborted it meanwhile
      await tx.insert(matchParticipants).values(a.userIds.map((userId) => ({ matchId: m.id, userId })));
      await this.d.outbox.add(tx, battleEvents.matchStartedV1, {
        key: m.id,
        recipients: a.userIds,
        data: {
          matchId: m.id,
          problemId: m.problemId!,
          userIds: a.userIds,
          startedAt: m.startedAt!.toISOString(),
          endsAt: m.endsAt!.toISOString(),
          version: m.version,
        },
      });
      await addJobToOutbox(tx, {
        queue: QUEUES.matchTimeout,
        jobId: `match-timeout-${m.id}`,
        name: 'timeout',
        data: { matchId: m.id },
        runAt: m.endsAt!,
      });
      return m;
    });
    this.d.afterCommit?.();
    end({ outcome: started?.status === 'in_progress' ? 'started' : 'aborted' });
    return { matchId: a.matchId, status: started?.status ?? 'aborted' };
  }

  /** Compensation / stuck start / missing verdicts: no result, no coins, both players freed. */
  async abort(
    matchId: string,
    reason: string,
    from: MatchRow['status'][] = ['created', 'in_progress', 'deciding'],
  ): Promise<boolean> {
    const ok = await withTransaction(this.d.db, (tx) => this.abortTx(tx, matchId, reason, from));
    if (ok) this.d.afterCommit?.();
    return ok;
  }

  private async abortTx(
    tx: Tx,
    matchId: string,
    reason: string,
    from: MatchRow['status'][],
  ): Promise<boolean> {
    const [m] = await tx
      .update(matches)
      .set({
        status: 'aborted',
        endReason: 'aborted',
        endedAt: sql`now()`,
        version: sql`${matches.version} + 1`,
      })
      .where(and(eq(matches.id, matchId), inArray(matches.status, from)))
      .returning();
    if (!m) return false;
    finished.inc({ end_reason: 'aborted' });
    const freed = await tx.delete(userActiveMatch).where(eq(userActiveMatch.matchId, matchId)).returning();
    const userIds = freed.length ? freed.map((f) => f.userId) : await this.participantIds(tx, matchId);
    await this.d.outbox.add(tx, battleEvents.matchAbortedV1, {
      key: matchId,
      recipients: userIds,
      data: { matchId, userIds, reason, version: m.version },
    });
    return true;
  }

  // ---------------- judge events → read model → winner (plan §11.3) ----------------

  /** Kafka handlers run inside the consumer's inbox transaction, so a redelivery is a no-op. */
  async onSubmissionCreated(tx: Tx, e: EventData<typeof judgeEvents.submissionCreatedV1>): Promise<void> {
    if (!e.matchId || e.mode !== 'submit') return;
    await tx
      .insert(matchSubmissions)
      .values({
        submissionId: e.submissionId,
        matchId: e.matchId,
        userId: e.userId,
        submittedAt: new Date(e.submittedAt),
      })
      .onConflictDoNothing();
  }

  async onSubmissionJudged(tx: Tx, e: EventData<typeof judgeEvents.submissionJudgedV1>): Promise<void> {
    if (!e.matchId || e.mode !== 'submit') return;
    await tx
      .insert(matchSubmissions)
      .values({
        submissionId: e.submissionId,
        matchId: e.matchId,
        userId: e.userId,
        submittedAt: new Date(e.submittedAt),
        verdict: e.verdict,
        judgedAt: new Date(e.judgedAt),
      })
      .onConflictDoUpdate({
        target: matchSubmissions.submissionId,
        set: { verdict: e.verdict, judgedAt: new Date(e.judgedAt) },
      });
    // same transaction: the verdict just written must be visible to the decision
    await this.evaluateTx(tx, e.matchId);
  }

  /**
   * Decide what the match does now. The row lock serialises concurrent evaluations (two verdicts,
   * a verdict and the timeout job); the CAS in every transition makes replays harmless.
   */
  async evaluate(matchId: string): Promise<void> {
    const changed = await withTransaction(this.d.db, (tx) => this.evaluateTx(tx, matchId));
    if (changed) this.d.afterCommit?.();
  }

  async evaluateTx(tx: Tx, matchId: string): Promise<boolean> {
    {
      const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for('update');
      if (!m || !isOpen(m.status) || !m.endsAt) return false;
      const subs = await tx.select().from(matchSubmissions).where(eq(matchSubmissions.matchId, matchId));
      const now = await this.dbNow(tx);
      const capReached = m.status === 'deciding' && !!m.decideDeadline && now >= m.decideDeadline;
      const decision = decide(subs, { now, endsAt: m.endsAt, capReached });

      switch (decision.kind) {
        case 'continue':
          return false;
        case 'deciding':
          return this.enterDeciding(tx, m);
        case 'winner':
          return this.complete(tx, m, decision.userId, 'solved');
        case 'timeout':
          return this.complete(tx, m, null, 'timeout');
        case 'abort':
          return this.abortTx(tx, m.id, 'Some verdicts never arrived, so this match has no result', [
            ...OPEN,
          ]);
      }
    }
  }

  private async enterDeciding(tx: Tx, m: MatchRow): Promise<boolean> {
    if (m.status === 'deciding') return false;
    const [u] = await tx
      .update(matches)
      .set({
        status: 'deciding',
        decideDeadline: sql`now() + make_interval(secs => ${this.d.decideCapSec})`,
        version: sql`${matches.version} + 1`,
      })
      .where(and(eq(matches.id, m.id), eq(matches.status, 'in_progress')))
      .returning();
    if (!u) return false;
    const userIds = await this.participantIds(tx, m.id);
    await this.d.outbox.add(tx, battleEvents.matchDecidingV1, {
      key: m.id,
      recipients: userIds,
      data: { matchId: m.id, userIds, decideDeadline: u.decideDeadline!.toISOString(), version: u.version },
    });
    // the cap resolves the match even if no more verdicts come (the reconciler is the backstop)
    await addJobToOutbox(tx, {
      queue: QUEUES.matchTimeout,
      jobId: `match-decide-${m.id}`,
      name: 'decide',
      data: { matchId: m.id },
      runAt: u.decideDeadline!,
    });
    return true;
  }

  private async complete(
    tx: Tx,
    m: MatchRow,
    winnerId: string | null,
    endReason: 'solved' | 'forfeit' | 'timeout',
  ): Promise<boolean> {
    const [u] = await tx
      .update(matches)
      .set({
        status: 'completed',
        winnerId,
        endReason,
        endedAt: sql`now()`,
        version: sql`${matches.version} + 1`,
      })
      .where(and(eq(matches.id, m.id), inArray(matches.status, [...OPEN])))
      .returning();
    if (!u) return false; // someone else finished it first
    finished.inc({ end_reason: endReason });
    const userIds = await this.participantIds(tx, m.id);
    const res = results(userIds, { winnerId, endReason });
    for (const userId of userIds) {
      await tx
        .update(matchParticipants)
        .set({ result: res[userId] ?? null })
        .where(and(eq(matchParticipants.matchId, m.id), eq(matchParticipants.userId, userId)));
    }
    await tx.delete(userActiveMatch).where(eq(userActiveMatch.matchId, m.id));
    await this.d.outbox.add(tx, battleEvents.matchCompletedV1, {
      key: m.id,
      recipients: userIds,
      data: {
        matchId: m.id,
        problemId: u.problemId!,
        userIds,
        winnerId,
        endReason,
        results: Object.fromEntries(Object.entries(res).filter(([, r]) => r !== null)) as Record<
          string,
          'win' | 'loss' | 'draw'
        >,
        startedAt: u.startedAt!.toISOString(),
        endedAt: u.endedAt!.toISOString(),
        version: u.version,
      },
    });
    return true;
  }

  // ---------------- forfeit (plan §11.5) ----------------

  async forfeit(me: string, matchId: string): Promise<void> {
    const done = await withTransaction(this.d.db, async (tx) => {
      const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for('update');
      const ids = m ? await this.participantIds(tx, matchId) : [];
      if (!m || !ids.includes(me)) throw notFound('Match');
      if (!isOpen(m.status)) throw conflict('MATCH_NOT_ACTIVE', 'This match is already over');
      return this.complete(tx, m, ids.find((id) => id !== me) ?? null, 'forfeit');
    });
    if (done) this.d.afterCommit?.();
  }

  // ---------------- reads ----------------

  /** judge-service intake (plan §11.3): may this user submit in this match? */
  async participation(matchId: string, userId: string): Promise<Participation> {
    const [m] = await this.d.db.select().from(matches).where(eq(matches.id, matchId));
    if (!m) throw notFound('Match');
    const [p] = await this.d.db
      .select()
      .from(matchParticipants)
      .where(and(eq(matchParticipants.matchId, matchId), eq(matchParticipants.userId, userId)));
    return {
      matchId,
      userId,
      participant: !!p,
      status: m.status,
      problemId: m.problemId,
      endsAt: iso(m.endsAt),
    };
  }

  /** For the rejoin banner (plan §11.6). */
  async active(me: string): Promise<ActiveMatch | null> {
    const [row] = await this.d.db
      .select({ m: matches })
      .from(userActiveMatch)
      .innerJoin(matches, eq(matches.id, userActiveMatch.matchId))
      .where(eq(userActiveMatch.userId, me));
    if (!row) return null;
    const [other] = await this.d.db
      .select({ userId: userActiveMatch.userId })
      .from(userActiveMatch)
      .where(and(eq(userActiveMatch.matchId, row.m.id), sql`${userActiveMatch.userId} <> ${me}`));
    const opponent = other ? ((await this.d.users.players([other.userId])).get(other.userId) ?? null) : null;
    return { matchId: row.m.id, status: row.m.status, opponent, endsAt: iso(row.m.endsAt) };
  }

  /** /battle/{id} snapshot (plan §11.6); participants only. */
  async state(me: string, matchId: string): Promise<MatchState> {
    const [m] = await this.d.db.select().from(matches).where(eq(matches.id, matchId));
    const ids = m ? await this.participantIds(this.d.db, matchId) : [];
    if (!m || !ids.includes(me)) throw notFound('Match');
    const subs = await this.d.db
      .select()
      .from(matchSubmissions)
      .where(eq(matchSubmissions.matchId, matchId))
      .orderBy(matchSubmissions.submittedAt);
    const players = await this.d.users.players(ids);
    const theirs = subs.filter((s) => s.userId !== me);
    return {
      matchId: m.id,
      status: m.status,
      problemId: m.problemId,
      problemSlug: m.problemSlug,
      players: ids.map((id) => players.get(id)).filter((p): p is Player => !!p),
      startedAt: iso(m.startedAt),
      endsAt: iso(m.endsAt),
      decideDeadline: iso(m.decideDeadline),
      endedAt: iso(m.endedAt),
      winnerId: m.winnerId,
      endReason: m.endReason,
      serverNow: (await this.dbNow(this.d.db)).toISOString(),
      mySubmissions: subs
        .filter((s) => s.userId === me)
        .map((s) => ({
          submissionId: s.submissionId,
          submittedAt: s.submittedAt.toISOString(),
          verdict: s.verdict,
        })),
      opponentProgress: { submitted: theirs.length, judged: theirs.filter((s) => s.verdict !== null).length },
    };
  }

  /** Match history, newest first (uuidv7 ids are time-ordered, so the id is the cursor). */
  async history(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: MatchHistoryItem[]; nextCursor: string | null }> {
    const rows = await this.d.db
      .select({ m: matches, result: matchParticipants.result })
      .from(matchParticipants)
      .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
      .where(
        and(
          eq(matchParticipants.userId, userId),
          inArray(matches.status, ['completed', 'aborted']),
          cursor ? lt(matchParticipants.matchId, cursor) : undefined,
        ),
      )
      .orderBy(desc(matchParticipants.matchId))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const others = page.length
      ? await this.d.db
          .select()
          .from(matchParticipants)
          .where(
            and(
              inArray(
                matchParticipants.matchId,
                page.map((r) => r.m.id),
              ),
              sql`${matchParticipants.userId} <> ${userId}`,
            ),
          )
      : [];
    const players = await this.d.users.players(others.map((o) => o.userId));
    return {
      items: page.map(({ m, result }) => {
        const o = others.find((x) => x.matchId === m.id);
        return {
          matchId: m.id,
          status: m.status,
          opponent: o ? (players.get(o.userId) ?? null) : null,
          result,
          endReason: m.endReason,
          problemSlug: m.problemSlug,
          startedAt: iso(m.startedAt),
          endedAt: iso(m.endedAt),
        };
      }),
      nextCursor: rows.length > limit ? (page.at(-1)?.m.id ?? null) : null,
    };
  }

  // ---------------- reconciler (plan §11.4): no Redis, no BullMQ ----------------

  async reconcile(): Promise<{ aborted: number; evaluated: number }> {
    const stuck = await this.d.db
      .select({ id: matches.id })
      .from(matches)
      .where(
        and(
          eq(matches.status, 'created'),
          sql`${matches.createdAt} < now() - make_interval(secs => ${CREATED_STUCK_MS / 1000})`,
        ),
      )
      .limit(100);
    let aborted = 0;
    for (const s of stuck) {
      if (await this.abort(s.id, "Couldn't start the match right now. Try again in a moment", ['created']))
        aborted++;
    }
    const due = await this.d.db
      .select({ id: matches.id })
      .from(matches)
      .where(
        sql`(${matches.status} = 'in_progress' and ${matches.endsAt} < now() - make_interval(secs => ${TIMEOUT_GRACE_MS / 1000}))
            or (${matches.status} = 'deciding' and ${matches.decideDeadline} < now())`,
      )
      .limit(100);
    for (const m of due) await this.evaluate(m.id);
    return { aborted, evaluated: due.length };
  }

  private async participantIds(ex: Db | Tx, matchId: string): Promise<string[]> {
    const rows = await ex
      .select({ userId: matchParticipants.userId })
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, matchId));
    return rows.map((r) => r.userId).sort();
  }

  private async dbNow(ex: Db | Tx): Promise<Date> {
    const { rows } = await ex.execute<{ now: Date | string }>(sql`select now() as now`);
    return new Date(rows[0]!.now);
  }
}
