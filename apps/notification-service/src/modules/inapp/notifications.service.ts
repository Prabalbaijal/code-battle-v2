import {
  notificationEvents,
  notificationSchema,
  type EventData,
  type EventEnvelope,
  type Notification,
  type NotificationType,
  type battleEvents,
  type Player,
  type ratingEvents,
  type userEvents,
} from '@cb/contracts';
import type { Db, Executor, Tx } from '@cb/db';
import { notFound } from '@cb/errors';
import type { OutboxWriter } from '@cb/events';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { notifications, type NotificationRow } from '../../db/schema.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import type { UserDirectory } from './users.js';

export interface NotificationServiceDeps {
  db: Db;
  outbox: OutboxWriter;
  users: UserDirectory;
  logger: Logger;
}

const keyset = z.object({ t: z.string(), id: z.uuid() });
const TS = sql<string>`to_char(${notifications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** The badge shows "99+" beyond this; counting further is wasted work. */
const UNREAD_CAP = 100;

export const toNotification = (r: NotificationRow): Notification =>
  notificationSchema.parse({
    id: r.id,
    type: r.type,
    payload: r.payload,
    readAt: r.readAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  });

const unknownPlayer = (id: string): Player => ({ id, username: 'player', fullname: '', avatarUrl: null });

/**
 * In-app notifications from events (plan §8.8, §11.9). Every write runs in the consumer's inbox
 * transaction and emits `notification.upserted` through the outbox, which realtime pushes as
 * `notification:new`.
 */
export class NotificationService {
  constructor(private readonly d: NotificationServiceDeps) {}

  // ---------------- from events ----------------

  async onFriendship(
    tx: Tx,
    env: EventEnvelope<EventData<typeof userEvents.friendshipChangedV1>>,
  ): Promise<void> {
    const e = env.data;
    const other = e.targetId;
    switch (e.change) {
      case 'requested': {
        const from = await this.player(e.actorId);
        await this.create(tx, other, 'friend_request', `friend_request:${env.id}`, { from });
        return;
      }
      case 'accepted': {
        // the request is answered: clear it from the accepter's list, tell the requester
        await this.readFriendRequests(tx, e.actorId, other);
        const by = await this.player(e.actorId);
        await this.create(tx, other, 'friend_accepted', `friend_accepted:${env.id}`, { by });
        return;
      }
      case 'rejected':
        await this.readFriendRequests(tx, e.actorId, other);
        return;
      case 'cancelled':
        await this.readFriendRequests(tx, other, e.actorId);
        return;
      case 'removed':
        return;
    }
  }

  async onChallengeCreated(tx: Tx, e: EventData<typeof battleEvents.challengeCreatedV1>): Promise<void> {
    await this.create(tx, e.toUserId, 'challenge_received', `challenge:${e.challengeId}`, {
      challengeId: e.challengeId,
      from: { id: e.fromUserId, ...e.from },
      expiresAt: e.expiresAt,
      status: 'pending',
    });
  }

  /** Answered (or withdrawn) challenges are read; an expired one stays unread: a missed challenge. */
  async onChallengeClosed(
    tx: Tx,
    e: EventData<typeof battleEvents.challengeRejectedV1>,
    status: 'accepted' | 'rejected' | 'cancelled' | 'expired',
  ): Promise<void> {
    const [row] = await tx
      .update(notifications)
      .set({
        payload: sql`jsonb_set(${notifications.payload}, '{status}', ${JSON.stringify(status)}::jsonb)`,
        ...(status === 'expired' ? {} : { readAt: sql`coalesce(${notifications.readAt}, now())` }),
      })
      .where(
        and(eq(notifications.userId, e.toUserId), eq(notifications.dedupeKey, `challenge:${e.challengeId}`)),
      )
      .returning();
    if (row) await this.emit(tx, row);
  }

  async onMatchCompleted(tx: Tx, e: EventData<typeof battleEvents.matchCompletedV1>): Promise<void> {
    const people = await this.players(e.userIds);
    for (const userId of e.userIds) {
      const opponentId = e.userIds.find((id) => id !== userId);
      await this.merge(tx, userId, `match:${e.matchId}`, {
        matchId: e.matchId,
        result: e.results[userId] ?? null,
        endReason: e.endReason,
        opponent: opponentId ? (people.get(opponentId) ?? unknownPlayer(opponentId)) : null,
      });
    }
  }

  /** The real coin change lands on the same match notification (either event may come first). */
  async onStatsChanged(tx: Tx, e: EventData<typeof ratingEvents.statsChangedV1>): Promise<void> {
    if (!e.matchId) return;
    await this.merge(tx, e.userId, `match:${e.matchId}`, { matchId: e.matchId, coinDelta: e.delta });
  }

  // ---------------- API ----------------

  async list(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: Notification[]; nextCursor: string | null }> {
    const after = decodeCursor(keyset, cursor);
    const rows = await this.d.db
      .select({ row: notifications, ts: TS })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          after
            ? sql`(${notifications.createdAt}, ${notifications.id}) < (${after.t}::timestamptz, ${after.id})`
            : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map((r) => toNotification(r.row)),
      nextCursor: rows.length > limit && last ? encodeCursor({ t: last.ts, id: last.row.id }) : null,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    const rows = await this.d.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .limit(UNREAD_CAP);
    return rows.length;
  }

  async read(userId: string, id: string): Promise<Notification> {
    await this.d.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)));
    const [row] = await this.d.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
    if (!row) throw notFound('Notification');
    return toNotification(row);
  }

  async readAll(userId: string): Promise<number> {
    const rows = await this.d.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return rows.length;
  }

  // ---------------- internals ----------------

  private async create(
    tx: Executor,
    userId: string,
    type: NotificationType,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const [row] = await tx
      .insert(notifications)
      .values({ id: newId(), userId, type, payload, dedupeKey })
      .onConflictDoNothing()
      .returning();
    if (row) await this.emit(tx, row);
  }

  /** Insert or merge into the match notification: only the fields this event knows overwrite. */
  private async merge(
    tx: Executor,
    userId: string,
    dedupeKey: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const payload = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== null && v !== undefined),
    );
    const [row] = await tx
      .insert(notifications)
      .values({ id: newId(), userId, type: 'match_result', payload, dedupeKey })
      .onConflictDoUpdate({
        target: [notifications.userId, notifications.dedupeKey],
        set: { payload: sql`${notifications.payload} || excluded.payload` },
      })
      .returning();
    if (row) await this.emit(tx, row);
  }

  private async readFriendRequests(tx: Executor, recipientId: string, fromId: string): Promise<void> {
    const rows = await tx
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(notifications.userId, recipientId),
          eq(notifications.type, 'friend_request'),
          isNull(notifications.readAt),
          sql`${notifications.payload} -> 'from' ->> 'id' = ${fromId}`,
        ),
      )
      .returning();
    for (const row of rows) await this.emit(tx, row);
  }

  private async emit(tx: Executor, row: NotificationRow): Promise<void> {
    await this.d.outbox.add(tx, notificationEvents.notificationUpsertedV1, {
      key: row.userId,
      recipients: [row.userId],
      data: { userId: row.userId, notification: toNotification(row) },
    });
  }

  private async player(id: string): Promise<Player> {
    return (await this.players([id])).get(id) ?? unknownPlayer(id);
  }

  /** Throws when user-service is down: the consumer retries (names matter more than speed). */
  private players(ids: string[]): Promise<Map<string, Player>> {
    return this.d.users.players(ids);
  }
}
