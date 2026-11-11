import { z } from 'zod';

export const playerStatsSchema = z.object({
  userId: z.uuid(),
  coins: z.number(),
  level: z.number(),
  wins: z.number(),
  losses: z.number(),
  draws: z.number(),
  streak: z.number(),
  bestStreak: z.number(),
  updatedAt: z.iso.datetime(),
});
export type PlayerStats = z.infer<typeof playerStatsSchema>;

export const leaderboardEntrySchema = z.object({
  rank: z.number(),
  userId: z.uuid(),
  username: z.string(),
  fullname: z.string(),
  avatarUrl: z.string().nullable(),
  coins: z.number(),
  level: z.number(),
  wins: z.number(),
  losses: z.number(),
});
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

export const myRankSchema = z.object({ rank: z.number().nullable(), coins: z.number(), level: z.number() });
export type MyRank = z.infer<typeof myRankSchema>;

/** GET /leaderboard (plan §15): the top 50 (or friends), plus where the viewer stands. */
export const leaderboardSchema = z.object({
  scope: z.enum(['global', 'friends']),
  items: z.array(leaderboardEntrySchema),
  me: myRankSchema.nullable(),
  /** Served from Postgres because Redis is unavailable (still correct, a bit slower). */
  fallback: z.boolean(),
});
export type Leaderboard = z.infer<typeof leaderboardSchema>;

/** One coin change: the profile's history shows the real delta (v1 bug #21). */
export const ledgerEntrySchema = z.object({
  id: z.uuid(),
  matchId: z.uuid().nullable(),
  reason: z.string(),
  delta: z.number(),
  applied: z.number(),
  balanceAfter: z.number(),
  createdAt: z.iso.datetime(),
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export const ledgerPageSchema = z.object({
  items: z.array(ledgerEntrySchema),
  nextCursor: z.string().nullable(),
});
