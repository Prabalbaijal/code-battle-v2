import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Infra tables every service owns (outbox, inbox, dead letters).
export { deadLetters, outbox, processedEvents } from '@cb/events';

const tsz = (name: string) => timestamp(name, { withTimezone: true });

/** Plan §15: one row per player, the source of truth for coins (Redis is only an index). */
export const playerStats = pgTable(
  'player_stats',
  {
    userId: uuid('user_id').primaryKey(),
    coins: integer('coins').notNull().default(400),
    level: integer('level').notNull().default(1),
    wins: integer('wins').notNull().default(0),
    losses: integer('losses').notNull().default(0),
    draws: integer('draws').notNull().default(0),
    currentStreak: integer('current_streak').notNull().default(0),
    bestStreak: integer('best_streak').notNull().default(0),
    /** Admins are left off the leaderboard (v1 parity). */
    isAdmin: boolean('is_admin').notNull().default(false),
    version: integer('version').notNull().default(0),
    createdAt: tsz('created_at').notNull().defaultNow(),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('player_stats_coins_non_negative', sql`${t.coins} >= 0`),
    // the Redis-down fallback: top 50 and "how many are ahead of me" are index range scans
    index('player_stats_leaderboard')
      .on(t.coins.desc(), t.updatedAt, t.userId)
      .where(sql`not ${t.isAdmin}`),
  ],
);

/**
 * Every coin change, append-only (plan §16 auditing). `UNIQUE (match_id, user_id, reason)` makes a
 * replayed `match.completed` a no-op: the row is inserted once, and the stats change only then.
 */
export const coinLedger = pgTable(
  'coin_ledger',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    matchId: uuid('match_id'),
    reason: text('reason').notNull(),
    /** What the rules asked for (e.g. −50). */
    delta: integer('delta').notNull(),
    /** What really happened after the floor at 0 (v1 bug #21 showed `delta`). */
    applied: integer('applied').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('coin_ledger_once').on(t.matchId, t.userId, t.reason),
    index('coin_ledger_user_idx').on(t.userId, t.createdAt.desc(), t.id),
  ],
);

export type PlayerStatsRow = typeof playerStats.$inferSelect;
export type CoinLedgerRow = typeof coinLedger.$inferSelect;
