import type { Relationship } from '@cb/contracts';
import type { Executor } from '@cb/db';
import { and, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { friendships, profiles, type FriendshipRow, type ProfileRow } from '../../db/schema.js';

/** Canonical pair: UUID text order equals byte order for the fixed lowercase format. */
export function pairOf(a: string, b: string): { low: string; high: string } {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? { low: x, high: y } : { low: y, high: x };
}

const pairWhere = (low: string, high: string) =>
  and(eq(friendships.userLow, low), eq(friendships.userHigh, high));
const involves = (me: string) => or(eq(friendships.userLow, me), eq(friendships.userHigh, me));
const otherOf = (me: string) =>
  sql`case when ${friendships.userLow} = ${me}::uuid then ${friendships.userHigh} else ${friendships.userLow} end`;

export interface ListedFriendship {
  profile: ProfileRow;
  at: Date;
  /** updated_at as Postgres text: exact (µs) keyset cursor. */
  ts: string;
}

export interface KeysetAfter {
  t: string;
  id: string;
}

/** SQL only (plan §9.2). */
export const friendsRepository = {
  /**
   * Insert a pending request, or turn a request *I* ignored earlier into my own pending request.
   * No row returned → the pair already exists in another state (caller decides).
   */
  async insertOrReopen(
    ex: Executor,
    low: string,
    high: string,
    me: string,
  ): Promise<FriendshipRow | undefined> {
    const [r] = await ex
      .insert(friendships)
      .values({ userLow: low, userHigh: high, requestedBy: me, status: 'pending' })
      .onConflictDoUpdate({
        target: [friendships.userLow, friendships.userHigh],
        set: { status: 'pending', requestedBy: me, updatedAt: sql`now()` },
        setWhere: sql`${friendships.status} = 'ignored' and ${friendships.requestedBy} <> ${me}::uuid`,
      })
      .returning();
    return r;
  },

  async findForUpdate(ex: Executor, low: string, high: string): Promise<FriendshipRow | undefined> {
    const [r] = await ex.select().from(friendships).where(pairWhere(low, high)).for('update');
    return r;
  },

  async find(ex: Executor, low: string, high: string): Promise<FriendshipRow | undefined> {
    const [r] = await ex.select().from(friendships).where(pairWhere(low, high));
    return r;
  },

  /** Only the receiver of a pending request can accept it. */
  async accept(ex: Executor, low: string, high: string, me: string): Promise<FriendshipRow | undefined> {
    const [r] = await ex
      .update(friendships)
      .set({ status: 'accepted', updatedAt: sql`now()` })
      .where(and(pairWhere(low, high), eq(friendships.status, 'pending'), ne(friendships.requestedBy, me)))
      .returning();
    return r;
  },

  /** Silent reject: the requester keeps seeing "pending" (see `relationship`). */
  async reject(ex: Executor, low: string, high: string, me: string): Promise<boolean> {
    const r = await ex
      .update(friendships)
      .set({ status: 'ignored', updatedAt: sql`now()` })
      .where(and(pairWhere(low, high), eq(friendships.status, 'pending'), ne(friendships.requestedBy, me)))
      .returning({ s: friendships.status });
    return r.length > 0;
  },

  /** Withdraw my own request (pending, or silently ignored). Returns the status it had. */
  async cancel(
    ex: Executor,
    low: string,
    high: string,
    me: string,
  ): Promise<FriendshipRow['status'] | undefined> {
    const [r] = await ex
      .delete(friendships)
      .where(
        and(
          pairWhere(low, high),
          eq(friendships.requestedBy, me),
          inArray(friendships.status, ['pending', 'ignored']),
        ),
      )
      .returning({ status: friendships.status });
    return r?.status;
  },

  async remove(ex: Executor, low: string, high: string): Promise<boolean> {
    const r = await ex
      .delete(friendships)
      .where(and(pairWhere(low, high), eq(friendships.status, 'accepted')))
      .returning({ s: friendships.status });
    return r.length > 0;
  },

  /** Viewer-relative state. A request the other side ignored still looks "outgoing" to me. */
  async relationship(ex: Executor, me: string, other: string): Promise<Relationship> {
    const { low, high } = pairOf(me, other);
    const r = await friendsRepository.find(ex, low, high);
    if (!r) return 'none';
    if (r.status === 'accepted') return 'friends';
    if (r.requestedBy === me) return 'outgoing';
    return r.status === 'pending' ? 'incoming' : 'none';
  },

  /** Newest first, keyset on (updated_at, other user id). */
  async list(
    ex: Executor,
    me: string,
    kind: 'friends' | 'incoming' | 'outgoing',
    after: KeysetAfter | undefined,
    limit: number,
  ): Promise<ListedFriendship[]> {
    const filters: SQL[] = [involves(me)!];
    if (kind === 'friends') filters.push(eq(friendships.status, 'accepted'));
    if (kind === 'incoming') filters.push(eq(friendships.status, 'pending'), ne(friendships.requestedBy, me));
    if (kind === 'outgoing') {
      filters.push(eq(friendships.requestedBy, me), inArray(friendships.status, ['pending', 'ignored']));
    }
    if (after) {
      filters.push(
        sql`(${friendships.updatedAt}, ${profiles.userId}) < (${after.t}::timestamptz, ${after.id}::uuid)`,
      );
    }
    return ex
      .select({
        profile: profiles,
        at: friendships.updatedAt,
        ts: sql<string>`${friendships.updatedAt}::text`,
      })
      .from(friendships)
      .innerJoin(profiles, eq(profiles.userId, otherOf(me)))
      .where(and(...filters))
      .orderBy(desc(friendships.updatedAt), desc(profiles.userId))
      .limit(limit);
  },
};
