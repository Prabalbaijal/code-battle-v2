/**
 * Coins and levels (plan §15), exactly v1's rules. Pure: rating-service applies them in a
 * transaction with the ledger.
 */

export const STARTING_COINS = 400;
export const MATCH_STAKE = 50;

export const LEDGER_REASONS = [
  'signup_bonus',
  'match_win',
  'match_loss',
  'match_timeout',
  'forfeit_win',
  'forfeit_loss',
  'hint_purchase',
  'rejudge_reversal',
  'migration',
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export type MatchEndReason = 'solved' | 'forfeit' | 'timeout';
export type MatchResult = 'win' | 'loss' | 'draw';

/** What a finished match does to one player's coins. */
export function matchDelta(
  endReason: MatchEndReason,
  result: MatchResult,
): { reason: LedgerReason; delta: number } {
  if (endReason === 'timeout') return { reason: 'match_timeout', delta: -MATCH_STAKE };
  if (endReason === 'forfeit') {
    return result === 'win'
      ? { reason: 'forfeit_win', delta: MATCH_STAKE }
      : { reason: 'forfeit_loss', delta: -MATCH_STAKE };
  }
  return result === 'win'
    ? { reason: 'match_win', delta: MATCH_STAKE }
    : { reason: 'match_loss', delta: -MATCH_STAKE };
}

/** Coins never go below 0: `applied` is the change that really happened. */
export function applyDelta(coins: number, delta: number): { applied: number; balance: number } {
  const balance = Math.max(0, coins + delta);
  return { applied: balance - coins, balance };
}

/** v1: `< 500 → 1`, `< 900 → 2`, `< 1000 → 3`, else 4. */
export function levelFor(coins: number): number {
  if (coins < 500) return 1;
  if (coins < 900) return 2;
  if (coins < 1000) return 3;
  return 4;
}

/** Consecutive wins (a loss or a draw resets it). */
export const nextStreak = (streak: number, result: MatchResult): number =>
  result === 'win' ? streak + 1 : 0;

/**
 * Leaderboard ZSET score: coins first, then whoever reached that total earlier (plan §15).
 * Exact (below 2^53) up to about 900,000 coins, far beyond anything +50 per win reaches.
 */
export function leaderboardScore(coins: number, updatedAt: Date): number {
  return coins * 1e10 + (1e10 - Math.floor(updatedAt.getTime() / 1000));
}
