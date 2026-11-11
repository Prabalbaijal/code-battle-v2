import {
  type battleEvents,
  ratingEvents,
  type identityEvents,
  type EventData,
  type LedgerEntry,
  type PlayerStats,
} from '@cb/contracts';
import type { Db, Executor, Tx } from '@cb/db';
import type { OutboxWriter } from '@cb/events';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { applyDelta, levelFor, matchDelta, nextStreak, STARTING_COINS } from '@cb/scoring';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { coinLedger, playerStats, type PlayerStatsRow } from '../db/schema.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';

export interface StatsServiceDeps {
  db: Db;
  outbox: OutboxWriter;
  logger: Logger;
}

const keyset = z.object({ t: z.string(), id: z.uuid() });

export const toStats = (r: PlayerStatsRow): PlayerStats => ({
  userId: r.userId,
  coins: r.coins,
  level: r.level,
  wins: r.wins,
  losses: r.losses,
  draws: r.draws,
  streak: r.currentStreak,
  bestStreak: r.bestStreak,
  updatedAt: r.updatedAt.toISOString(),
});

/** A player rating-service hasn't heard of yet (the registration event may still be on its way). */
const fresh = (userId: string): PlayerStats => ({
  userId,
  coins: STARTING_COINS,
  level: levelFor(STARTING_COINS),
  wins: 0,
  losses: 0,
  draws: 0,
  streak: 0,
  bestStreak: 0,
  updatedAt: new Date(0).toISOString(),
});

/**
 * Coins, levels and the ledger (plan §15). Every write runs inside the consumer's inbox
 * transaction, so a redelivered event is a no-op (inbox), and a re-published one is too (ledger
 * unique key). Stats change only when a ledger row is really inserted.
 */
export class StatsService {
  constructor(private readonly d: StatsServiceDeps) {}

  async onRegistered(tx: Tx, e: EventData<typeof identityEvents.userRegisteredV1>): Promise<void> {
    await this.ensure(tx, e.userId, e.role === 'admin');
  }

  /** Admins are hidden from the leaderboard; a role change moves them on or off it. */
  async onRoleChanged(tx: Tx, e: EventData<typeof identityEvents.userRoleChangedV1>): Promise<void> {
    const isAdmin = e.role === 'admin';
    await this.ensure(tx, e.userId, isAdmin);
    const [row] = await tx
      .update(playerStats)
      .set({ isAdmin, version: sql`${playerStats.version} + 1` })
      .where(and(eq(playerStats.userId, e.userId), eq(playerStats.isAdmin, !isAdmin)))
      .returning();
    if (row) await this.emit(tx, row, { delta: 0, reason: 'visibility', matchId: null });
  }

  async onMatchCompleted(tx: Tx, e: EventData<typeof battleEvents.matchCompletedV1>): Promise<void> {
    const ids = [...new Set(e.userIds)].sort();
    for (const id of ids) await this.ensure(tx, id);
    // lock in a fixed order so two matches touching the same players can't deadlock
    const rows = await tx
      .select()
      .from(playerStats)
      .where(inArray(playerStats.userId, ids))
      .orderBy(asc(playerStats.userId))
      .for('update');

    for (const row of rows) {
      const result = e.results[row.userId];
      if (!result) {
        this.d.logger.warn({ matchId: e.matchId, userId: row.userId }, 'no result for participant');
        continue;
      }
      const { reason, delta } = matchDelta(e.endReason, result);
      const { applied, balance } = applyDelta(row.coins, delta);
      const inserted = await tx
        .insert(coinLedger)
        .values({
          id: newId(),
          userId: row.userId,
          matchId: e.matchId,
          reason,
          delta,
          applied,
          balanceAfter: balance,
          createdAt: new Date(e.endedAt),
        })
        .onConflictDoNothing()
        .returning({ id: coinLedger.id });
      if (!inserted.length) continue; // already applied: replays change nothing

      const streak = nextStreak(row.currentStreak, result);
      const [updated] = await tx
        .update(playerStats)
        .set({
          coins: balance,
          level: levelFor(balance),
          wins: sql`${playerStats.wins} + ${result === 'win' ? 1 : 0}`,
          losses: sql`${playerStats.losses} + ${result === 'loss' ? 1 : 0}`,
          draws: sql`${playerStats.draws} + ${result === 'draw' ? 1 : 0}`,
          currentStreak: streak,
          bestStreak: Math.max(row.bestStreak, streak),
          version: sql`${playerStats.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(playerStats.userId, row.userId))
        .returning();
      await this.emit(tx, updated!, { delta: applied, reason, matchId: e.matchId });
    }
  }

  async get(userId: string): Promise<PlayerStats> {
    const [row] = await this.d.db.select().from(playerStats).where(eq(playerStats.userId, userId));
    return row ? toStats(row) : fresh(userId);
  }

  async rows(ids: string[]): Promise<PlayerStatsRow[]> {
    if (!ids.length) return [];
    return this.d.db.select().from(playerStats).where(inArray(playerStats.userId, ids));
  }

  /** The player's own coin history, newest first, optionally only for some matches (profile BFF). */
  async ledger(
    userId: string,
    o: { cursor?: string | undefined; limit: number; matchIds?: string[] | undefined },
  ): Promise<{ items: LedgerEntry[]; nextCursor: string | null }> {
    const after = decodeCursor(keyset, o.cursor);
    const ts = sql<string>`to_char(${coinLedger.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const rows = await this.d.db
      .select({ row: coinLedger, ts })
      .from(coinLedger)
      .where(
        and(
          eq(coinLedger.userId, userId),
          o.matchIds?.length ? inArray(coinLedger.matchId, o.matchIds) : undefined,
          after
            ? sql`(${coinLedger.createdAt}, ${coinLedger.id}) < (${after.t}::timestamptz, ${after.id})`
            : undefined,
        ),
      )
      .orderBy(desc(coinLedger.createdAt), desc(coinLedger.id))
      .limit(o.limit + 1);
    const items = rows.slice(0, o.limit);
    const last = items.at(-1);
    return {
      items: items.map(({ row: r }) => ({
        id: r.id,
        matchId: r.matchId,
        reason: r.reason,
        delta: r.delta,
        applied: r.applied,
        balanceAfter: r.balanceAfter,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > o.limit && last ? encodeCursor({ t: last.ts, id: last.row.id }) : null,
    };
  }

  /** The stats row exists from the first event that mentions the player, with the signup bonus. */
  private async ensure(tx: Executor, userId: string, isAdmin = false): Promise<void> {
    const [row] = await tx
      .insert(playerStats)
      .values({ userId, coins: STARTING_COINS, level: levelFor(STARTING_COINS), isAdmin })
      .onConflictDoNothing()
      .returning();
    if (!row) return;
    await tx.insert(coinLedger).values({
      id: newId(),
      userId,
      matchId: null,
      reason: 'signup_bonus',
      delta: STARTING_COINS,
      applied: STARTING_COINS,
      balanceAfter: STARTING_COINS,
    });
    await this.emit(tx, row, { delta: STARTING_COINS, reason: 'signup_bonus', matchId: null });
  }

  private async emit(
    tx: Executor,
    r: PlayerStatsRow,
    change: { delta: number; reason: string; matchId: string | null },
  ): Promise<void> {
    await this.d.outbox.add(tx, ratingEvents.statsChangedV1, {
      key: r.userId,
      recipients: [r.userId],
      data: {
        userId: r.userId,
        coins: r.coins,
        level: r.level,
        wins: r.wins,
        losses: r.losses,
        draws: r.draws,
        streak: r.currentStreak,
        bestStreak: r.bestStreak,
        ...change,
        hidden: r.isAdmin,
        updatedAt: r.updatedAt.toISOString(),
      },
    });
  }
}
