import { battleEvents, type Challenge, type Player } from '@cb/contracts';
import { isUniqueViolation, withTransaction, type Db, type Tx } from '@cb/db';
import { AppError, badRequest, conflict, notFound } from '@cb/errors';
import type { OutboxWriter } from '@cb/events';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { addJobToOutbox } from '@cb/queue';
import { and, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { JudgeCapacity, PresenceSource, UserDirectory } from '../../clients.js';
import { challenges, userActiveMatch, type ChallengeRow } from '../../db/schema.js';
import { QUEUES } from '../../queues.js';

export interface ChallengeServiceDeps {
  db: Db;
  outbox: OutboxWriter;
  logger: Logger;
  users: UserDirectory;
  presence: PresenceSource;
  judge: JudgeCapacity;
  challengeTtlMs: number;
  afterCommit?: () => void;
}

const challengeEvent = (c: ChallengeRow) => ({
  challengeId: c.id,
  fromUserId: c.fromUser,
  toUserId: c.toUser,
});

/** Plan §11.1: pending → accepted | rejected | cancelled | expired, each by one CAS update. */
export class ChallengeService {
  constructor(private readonly d: ChallengeServiceDeps) {}

  async create(me: string, toUserId: string): Promise<Challenge> {
    if (toUserId === me) throw badRequest("You can't challenge yourself");
    const players = await this.d.users.players([me, toUserId]);
    const from = players.get(me);
    const to = players.get(toUserId);
    if (!to) throw notFound('User');
    if (!from) throw notFound('User');
    if (!(await this.d.presence.isOnline(toUserId))) {
      throw conflict('OPPONENT_OFFLINE', `${to.username} is offline`);
    }
    // v1 only checked the challenger; both must be free (plan §3 Δ)
    const busy = await this.d.db
      .select({ userId: userActiveMatch.userId })
      .from(userActiveMatch)
      .where(inArray(userActiveMatch.userId, [me, toUserId]));
    if (busy.length) {
      const who = busy.some((b) => b.userId === me) ? 'You are' : `${to.username} is`;
      throw conflict('USER_IN_ACTIVE_MATCH', `${who} already in a match`);
    }
    await this.admission();

    const id = newId();
    const expiresAt = new Date(Date.now() + this.d.challengeTtlMs);
    let row: ChallengeRow;
    try {
      row = await withTransaction(this.d.db, async (tx) => {
        const [c] = await tx
          .insert(challenges)
          .values({ id, fromUser: me, toUser: toUserId, status: 'pending', expiresAt })
          .returning();
        await this.d.outbox.add(tx, battleEvents.challengeCreatedV1, {
          key: id,
          recipients: [toUserId],
          data: {
            ...challengeEvent(c!),
            expiresAt: expiresAt.toISOString(),
            from: { username: from.username, fullname: from.fullname, avatarUrl: from.avatarUrl },
          },
        });
        await addJobToOutbox(tx, {
          queue: QUEUES.challengeExpire,
          jobId: `challenge-expire-${id}`,
          name: 'expire',
          data: { challengeId: id },
          runAt: expiresAt,
        });
        return c!;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'challenges_one_pending_per_pair')) {
        throw conflict('CHALLENGE_ALREADY_PENDING', `You already challenged ${to.username}`);
      }
      throw err;
    }
    this.d.afterCommit?.();
    return this.view(row, players);
  }

  async list(me: string, direction: 'incoming' | 'outgoing'): Promise<Challenge[]> {
    const rows = await this.d.db
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.status, 'pending'),
          sql`${challenges.expiresAt} > now()`,
          direction === 'incoming' ? eq(challenges.toUser, me) : eq(challenges.fromUser, me),
        ),
      )
      .orderBy(desc(challenges.createdAt))
      .limit(50);
    const players = await this.d.users.players(rows.flatMap((r) => [r.fromUser, r.toUser]));
    return rows.map((r) => this.view(r, players));
  }

  /** The recipient says no; the challenger is told. */
  reject(me: string, id: string): Promise<Challenge> {
    return this.close(id, 'rejected', eq(challenges.toUser, me), (c) => ({
      def: battleEvents.challengeRejectedV1,
      recipients: [c.fromUser],
    }));
  }

  /** The challenger takes it back; the recipient's notification goes away. */
  cancel(me: string, id: string): Promise<Challenge> {
    return this.close(id, 'cancelled', eq(challenges.fromUser, me), (c) => ({
      def: battleEvents.challengeCancelledV1,
      recipients: [c.toUser],
    }));
  }

  /** challenge-expire job (and the reconciler). Already handled → no-op. */
  async expire(id: string): Promise<boolean> {
    try {
      await this.close(
        id,
        'expired',
        lte(challenges.expiresAt, sql`now()`),
        (c) => ({ def: battleEvents.challengeExpiredV1, recipients: [c.fromUser, c.toUser] }),
        true,
      );
      return true;
    } catch (err) {
      if (err instanceof AppError && err.code === 'CHALLENGE_NOT_PENDING') return false;
      throw err;
    }
  }

  /** Reconciler: pending challenges whose expire job was lost (e.g. Redis was down). */
  async expireOverdue(): Promise<number> {
    const rows = await this.d.db
      .select({ id: challenges.id })
      .from(challenges)
      .where(
        and(eq(challenges.status, 'pending'), sql`${challenges.expiresAt} < now() - interval '5 seconds'`),
      )
      .limit(100);
    let n = 0;
    for (const r of rows) if (await this.expire(r.id)) n++;
    return n;
  }

  private async close(
    id: string,
    status: 'rejected' | 'cancelled' | 'expired',
    who: SQL,
    event: (c: ChallengeRow) => {
      def:
        | typeof battleEvents.challengeRejectedV1
        | typeof battleEvents.challengeCancelledV1
        | typeof battleEvents.challengeExpiredV1;
      recipients: string[];
    },
    quiet = false,
  ): Promise<Challenge> {
    const row = await withTransaction(this.d.db, async (tx: Tx) => {
      const [c] = await tx
        .update(challenges)
        .set({ status, updatedAt: sql`now()` })
        .where(and(eq(challenges.id, id), eq(challenges.status, 'pending'), who))
        .returning();
      if (!c) return undefined;
      const e = event(c);
      await this.d.outbox.add(tx, e.def, { key: id, recipients: e.recipients, data: challengeEvent(c) });
      return c;
    });
    if (!row) {
      if (!quiet) {
        const [c] = await this.d.db.select().from(challenges).where(eq(challenges.id, id));
        if (!c) throw notFound('Challenge');
      }
      throw conflict('CHALLENGE_NOT_PENDING', 'This challenge is no longer pending');
    }
    this.d.afterCommit?.();
    return this.view(row, await this.d.users.players([row.fromUser, row.toUser]));
  }

  /** Plan §14.6 admission control: no new matches when the judge can't serve them. */
  private async admission(): Promise<void> {
    let cap;
    try {
      cap = await this.d.judge.capacity();
    } catch (err) {
      this.d.logger.warn({ err }, 'judge capacity unavailable; refusing new challenges');
      throw new AppError('JUDGE_AT_CAPACITY', 503, 'The judge is unavailable right now. Try again soon.', {
        expose: true,
      });
    }
    if (cap.breaker === 'open' || cap.level === 'no_new_matches') {
      throw new AppError('JUDGE_AT_CAPACITY', 503, 'The judge is at capacity for today. Try again later.', {
        expose: true,
        details: { level: cap.level },
      });
    }
  }

  view(c: ChallengeRow, players: Map<string, Player>): Challenge {
    const p = (id: string): Player =>
      players.get(id) ?? { id, username: 'unknown', fullname: 'Unknown player', avatarUrl: null };
    return {
      id: c.id,
      from: p(c.fromUser),
      to: p(c.toUser),
      status: c.status,
      matchId: c.matchId,
      expiresAt: c.expiresAt.toISOString(),
      createdAt: c.createdAt.toISOString(),
    };
  }
}
