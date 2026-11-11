import { describe, expect, it } from 'vitest';
import { applyDelta, leaderboardScore, levelFor, matchDelta, nextStreak } from './index.js';

describe('scoring (v1 rules)', () => {
  it('win +50, loss −50, timeout −50 for both, forfeit: leaver −50 and opponent +50', () => {
    expect(matchDelta('solved', 'win')).toEqual({ reason: 'match_win', delta: 50 });
    expect(matchDelta('solved', 'loss')).toEqual({ reason: 'match_loss', delta: -50 });
    expect(matchDelta('timeout', 'draw')).toEqual({ reason: 'match_timeout', delta: -50 });
    expect(matchDelta('forfeit', 'win')).toEqual({ reason: 'forfeit_win', delta: 50 });
    expect(matchDelta('forfeit', 'loss')).toEqual({ reason: 'forfeit_loss', delta: -50 });
  });

  it('coins never go below 0; applied is the real change', () => {
    expect(applyDelta(400, -50)).toEqual({ applied: -50, balance: 350 });
    expect(applyDelta(30, -50)).toEqual({ applied: -30, balance: 0 });
    expect(applyDelta(0, -50)).toEqual({ applied: 0, balance: 0 });
  });

  it('levels: <500 → 1, <900 → 2, <1000 → 3, else 4', () => {
    expect([0, 499, 500, 899, 900, 999, 1000, 5000].map(levelFor)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('streaks count consecutive wins', () => {
    expect([nextStreak(2, 'win'), nextStreak(2, 'loss'), nextStreak(2, 'draw')]).toEqual([3, 0, 0]);
  });

  it('leaderboard score: more coins first, then whoever got there earlier', () => {
    const early = new Date('2026-11-01T00:00:00Z');
    const late = new Date('2026-11-02T00:00:00Z');
    expect(leaderboardScore(500, early)).toBeGreaterThan(leaderboardScore(500, late));
    expect(leaderboardScore(501, late)).toBeGreaterThan(leaderboardScore(500, early));
    expect(Number.isSafeInteger(leaderboardScore(900_000, late))).toBe(true); // safe up to ~900k coins
  });
});
