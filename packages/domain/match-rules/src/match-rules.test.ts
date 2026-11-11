import { describe, expect, it } from 'vitest';
import {
  canTransitionChallenge,
  canTransitionMatch,
  decide,
  results,
  type MatchSubmission,
} from './index.js';

const T0 = new Date('2026-11-12T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const ENDS = at(1800);
let n = 0;
const sub = (userId: string, s: number, verdict: string | null, id?: string): MatchSubmission => ({
  submissionId: id ?? `0000000${++n}`.slice(-8),
  userId,
  submittedAt: at(s),
  verdict,
});
const ctx = (nowS: number, capReached = false) => ({ now: at(nowS), endsAt: ENDS, capReached });

describe('state machines', () => {
  it('challenges only leave pending; matches follow created → in_progress → deciding → completed', () => {
    expect(canTransitionChallenge('pending', 'accepted')).toBe(true);
    expect(canTransitionChallenge('accepted', 'cancelled')).toBe(false);
    expect(canTransitionChallenge('pending', 'pending')).toBe(false);
    expect(canTransitionMatch('created', 'in_progress')).toBe(true);
    expect(canTransitionMatch('deciding', 'completed')).toBe(true);
    expect(canTransitionMatch('completed', 'aborted')).toBe(false);
    expect(canTransitionMatch('created', 'completed')).toBe(false);
  });
});

describe('decide', () => {
  it('nothing solved and time left: keep playing', () => {
    expect(decide([sub('a', 10, 'WA'), sub('b', 20, null)], ctx(30))).toEqual({ kind: 'continue' });
  });

  it('the earliest submitted AC wins, even if it was judged last', () => {
    const subs = [sub('b', 100, 'AC', 'b1'), sub('a', 90, 'AC', 'a1')];
    expect(decide(subs, ctx(120))).toEqual({ kind: 'winner', userId: 'a', submissionId: 'a1' });
  });

  it("an AC waits while the opponent's earlier submission is still being judged", () => {
    const subs = [sub('a', 50, null), sub('b', 60, 'AC')];
    expect(decide(subs, ctx(70))).toEqual({ kind: 'deciding' });
    // the earlier one turns out WA: b wins
    subs[0]!.verdict = 'WA';
    expect(decide(subs, ctx(80))).toMatchObject({ kind: 'winner', userId: 'b' });
  });

  it("the winner's own earlier pending submission doesn't block", () => {
    const subs = [sub('a', 50, null), sub('a', 60, 'AC')];
    expect(decide(subs, ctx(70))).toMatchObject({ kind: 'winner', userId: 'a' });
  });

  it('same submit time: the smaller (time-ordered) submission id wins', () => {
    const subs = [sub('b', 50, 'AC', 'id-2'), sub('a', 50, 'AC', 'id-1')];
    expect(decide(subs, ctx(60))).toMatchObject({ kind: 'winner', userId: 'a' });
  });

  it('time up: pending verdicts mean deciding; none and no AC means timeout', () => {
    expect(decide([sub('a', 1790, null)], ctx(1800))).toEqual({ kind: 'deciding' });
    expect(decide([sub('a', 1790, 'WA')], ctx(1800))).toEqual({ kind: 'timeout' });
    expect(decide([], ctx(1801))).toEqual({ kind: 'timeout' });
  });

  it('deciding cap: resolve with what we have, abort when no AC and verdicts are missing', () => {
    expect(decide([sub('a', 50, null), sub('b', 60, 'AC')], ctx(2400, true))).toMatchObject({
      kind: 'winner',
      userId: 'b',
    });
    expect(decide([sub('a', 1790, null)], ctx(2400, true))).toEqual({ kind: 'abort' });
  });

  it('submissions at or after the end never count', () => {
    expect(decide([sub('a', 1800, 'AC')], ctx(1805))).toEqual({ kind: 'timeout' });
  });
});

describe('results', () => {
  it('win/loss, draw on timeout, nothing on abort', () => {
    expect(results(['a', 'b'], { winnerId: 'a', endReason: 'solved' })).toEqual({ a: 'win', b: 'loss' });
    expect(results(['a', 'b'], { winnerId: null, endReason: 'timeout' })).toEqual({ a: 'draw', b: 'draw' });
    expect(results(['a', 'b'], { winnerId: null, endReason: 'aborted' })).toEqual({ a: null, b: null });
  });
});
