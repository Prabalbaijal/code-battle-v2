import { userEvents } from '@cb/contracts';
import { withTransaction, type Db, type Tx } from '@cb/db';
import { AppError, badRequest, conflict, notFound } from '@cb/errors';
import type { OutboxWriter } from '@cb/events';
import { z } from 'zod';
import type { ProfileRow } from '../../db/schema.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { profileRepository } from '../profile/profile.repository.js';
import { friendsRepository as repo, pairOf, type ListedFriendship } from './friends.repository.js';

export interface FriendsServiceDeps {
  db: Db;
  outbox: OutboxWriter;
  afterCommit?: () => void;
}

const keyset = z.object({ t: z.string().max(40), id: z.uuid() });
type Change = (typeof userEvents.FRIENDSHIP_CHANGES)[number];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Friendships (plan §9.2, §11.9). Invariants come from the canonical-pair primary key and
 * conditional updates, so concurrent A→B / B→A requests can't create two rows.
 */
export class FriendsService {
  constructor(private readonly d: FriendsServiceDeps) {}

  async sendRequest(
    me: string,
    toUserId: string,
  ): Promise<{ status: 'pending' | 'accepted'; user: ProfileRow }> {
    const other = toUserId.toLowerCase();
    if (other === me) throw badRequest('You cannot send a friend request to yourself');
    const target = await profileRepository.findById(this.d.db, other);
    if (!target) throw notFound('User');
    const { low, high } = pairOf(me, other);

    const result = await withTransaction(this.d.db, async (tx) => {
      // Two passes: a concurrent cancel/remove can delete the row between the upsert and the lock.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await repo.insertOrReopen(tx, low, high, me)) {
          await this.emit(tx, low, high, 'requested', me, other, [other]);
          return 'pending' as const;
        }
        const existing = await repo.findForUpdate(tx, low, high);
        if (!existing) continue;
        if (existing.status === 'accepted') throw conflict('ALREADY_FRIENDS', 'You are already friends');
        if (existing.requestedBy === me) {
          // Ignored by them: stay silent and look pending. Still pending: a real duplicate.
          if (existing.status === 'ignored') return 'pending' as const;
          throw conflict('FRIEND_REQUEST_EXISTS', 'Friend request already sent');
        }
        // They asked us first: a mutual request makes us friends.
        if (await repo.accept(tx, low, high, me)) {
          await this.emit(tx, low, high, 'accepted', me, other, [me, other]);
          return 'accepted' as const;
        }
      }
      throw new AppError('CONFLICT', 409, 'Friendship changed concurrently; retry');
    });
    this.d.afterCommit?.();
    return { status: result, user: target };
  }

  /** Idempotent: accepting an already-accepted request succeeds. */
  async accept(me: string, otherUserId: string): Promise<void> {
    const other = otherUserId.toLowerCase();
    const { low, high } = pairOf(me, other);
    await withTransaction(this.d.db, async (tx) => {
      if (await repo.accept(tx, low, high, me)) {
        await this.emit(tx, low, high, 'accepted', me, other, [me, other]);
        return;
      }
      const existing = await repo.find(tx, low, high);
      if (existing?.status !== 'accepted') throw notFound('Friend request');
    });
    this.d.afterCommit?.();
  }

  async reject(me: string, otherUserId: string): Promise<void> {
    const other = otherUserId.toLowerCase();
    const { low, high } = pairOf(me, other);
    await withTransaction(this.d.db, async (tx) => {
      if (!(await repo.reject(tx, low, high, me))) throw notFound('Friend request');
      // Silent: only my own sessions hear about it.
      await this.emit(tx, low, high, 'rejected', me, other, [me]);
    });
    this.d.afterCommit?.();
  }

  async cancel(me: string, otherUserId: string): Promise<void> {
    const other = otherUserId.toLowerCase();
    const { low, high } = pairOf(me, other);
    await withTransaction(this.d.db, async (tx) => {
      const was = await repo.cancel(tx, low, high, me);
      if (!was) throw notFound('Friend request');
      await this.emit(tx, low, high, 'cancelled', me, other, was === 'pending' ? [me, other] : [me]);
    });
    this.d.afterCommit?.();
  }

  async remove(me: string, otherUserId: string): Promise<void> {
    const other = otherUserId.toLowerCase();
    const { low, high } = pairOf(me, other);
    await withTransaction(this.d.db, async (tx) => {
      if (!(await repo.remove(tx, low, high))) throw notFound('Friend');
      await this.emit(tx, low, high, 'removed', me, other, [me, other]);
    });
    this.d.afterCommit?.();
  }

  list(me: string, kind: 'friends' | 'incoming' | 'outgoing', cursor: string | undefined, limit: number) {
    return this.page(me, kind, cursor, limit);
  }

  private async page(
    me: string,
    kind: 'friends' | 'incoming' | 'outgoing',
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<ListedFriendship>> {
    const after = decodeCursor(keyset, cursor);
    const rows = await repo.list(this.d.db, me, kind, after, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor({ t: last.ts, id: last.profile.userId }) : null,
    };
  }

  private emit(
    tx: Tx,
    low: string,
    high: string,
    change: Change,
    actorId: string,
    targetId: string,
    recipients: string[],
  ) {
    return this.d.outbox.add(tx, userEvents.friendshipChangedV1, {
      key: low,
      data: { userLow: low, userHigh: high, change, actorId, targetId, at: new Date().toISOString() },
      recipients,
    });
  }
}
