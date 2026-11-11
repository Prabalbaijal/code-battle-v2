import {
  battleEvents,
  judgeEvents,
  notificationEvents,
  ratingEvents,
  userEvents,
  type EnvelopeBase,
} from '@cb/contracts';
import { describe, expect, it } from 'vitest';
import { route } from './delivery.js';

const A = '01a1c000-0000-7000-8000-00000000000a';
const B = '01a1c000-0000-7000-8000-00000000000b';
const M = '01a1c000-0000-7000-8000-0000000000aa';
const S = '01a1c000-0000-7000-8000-0000000000bb';
const P = '01a1c000-0000-7000-8000-0000000000cc';
const env = (type: string, data: object, recipients?: string[]): EnvelopeBase => ({
  id: '01a1c000-0000-7000-8000-0000000000ee',
  type,
  source: 'test',
  occurredAt: '2026-11-12T10:00:00.000Z',
  aggregateId: M,
  ...(recipients ? { recipients } : {}),
  data,
});

describe('route', () => {
  it('a challenge goes to its recipient with the challenger shown', () => {
    const r = route(
      env(
        battleEvents.challengeCreatedV1.type,
        {
          challengeId: S,
          fromUserId: A,
          toUserId: B,
          expiresAt: '2026-11-12T10:00:30.000Z',
          from: { username: 'alice', fullname: 'Alice', avatarUrl: null },
        },
        [B],
      ),
    );
    expect(r.deliveries).toEqual([
      {
        to: { userIds: [B] },
        event: 'challenge:received',
        message: expect.objectContaining({
          eventId: '01a1c000-0000-7000-8000-0000000000ee',
          data: {
            challengeId: S,
            from: { userId: A, username: 'alice', fullname: 'Alice', avatarUrl: null },
            expiresAt: '2026-11-12T10:00:30.000Z',
          },
        }),
      },
    ]);
  });

  it('match events carry seq = matches.version and mark both players in a match', () => {
    const r = route(
      env(
        battleEvents.matchStartedV1.type,
        {
          matchId: M,
          problemId: P,
          userIds: [A, B],
          startedAt: '2026-11-12T10:00:00.000Z',
          endsAt: '2026-11-12T10:30:00.000Z',
          version: 1,
        },
        [A, B],
      ),
      new Date('2026-11-12T10:00:01Z'),
    );
    expect(r.deliveries[0]).toMatchObject({
      to: { userIds: [A, B] },
      event: 'match:started',
      message: { seq: 1, data: { matchId: M, serverNow: '2026-11-12T10:00:01.000Z' } },
    });
    expect(r.effects).toEqual([{ kind: 'match-started', matchId: M, userIds: [A, B] }]);
  });

  it('a verdict: details to the submitter, only "judged" + verdict to the opponent', () => {
    const r = route(
      env(judgeEvents.submissionJudgedV1.type, {
        submissionId: S,
        matchId: M,
        userId: A,
        problemId: P,
        mode: 'submit',
        verdict: 'WA',
        failedFile: 2,
        failedCase: 4,
        maxCpuMs: 12,
        maxMemKb: 900,
        fromCache: false,
        submittedAt: '2026-11-12T10:00:00.000Z',
        judgedAt: '2026-11-12T10:00:01.000Z',
      }),
    );
    expect(r.deliveries.map((d) => [d.to, d.event])).toEqual([
      [{ userIds: [A] }, 'submission:verdict'],
      [{ opponentsOf: { matchId: M, userId: A } }, 'match:opponent-activity'],
    ]);
    expect(r.deliveries[1]!.message.data).toEqual({ matchId: M, type: 'judged', verdict: 'WA' });
  });

  it('practice runs reach only the submitter; friendship changes only invalidate caches', () => {
    const run = route(
      env(judgeEvents.submissionCreatedV1.type, {
        submissionId: S,
        matchId: null,
        userId: A,
        problemId: P,
        mode: 'run',
        submittedAt: '2026-11-12T10:00:00.000Z',
      }),
    );
    expect(run).toEqual({ deliveries: [], effects: [] });
    const f = route(
      env(userEvents.friendshipChangedV1.type, {
        userLow: A,
        userHigh: B,
        change: 'accepted',
        actorId: B,
        targetId: A,
        at: '2026-11-12T10:00:00.000Z',
      }),
    );
    expect(f).toEqual({
      deliveries: [],
      effects: [{ kind: 'friendship', userLow: A, userHigh: B, accepted: true }],
    });
  });

  it('a coin change goes to its player as stats:updated; a visibility change does not', () => {
    const data = {
      userId: A,
      coins: 450,
      level: 1,
      wins: 1,
      losses: 0,
      draws: 0,
      streak: 1,
      bestStreak: 1,
      delta: 50,
      reason: 'match_win',
      matchId: M,
      hidden: false,
      updatedAt: '2026-11-12T10:00:00.000Z',
    };
    const r = route(env(ratingEvents.statsChangedV1.type, data, [A]));
    expect(r.deliveries).toEqual([
      {
        to: { userIds: [A] },
        event: 'stats:updated',
        message: expect.objectContaining({ data: { coins: 450, level: 1, delta: 50, matchId: M } }),
      },
    ]);
    const hidden = { ...data, delta: 0, reason: 'visibility', matchId: null, hidden: true };
    expect(route(env(ratingEvents.statsChangedV1.type, hidden, [A])).deliveries).toEqual([]);
  });

  it('a notification goes to its owner as notification:new', () => {
    const notification = {
      id: S,
      type: 'friend_request',
      payload: { from: { id: A, username: 'alice', fullname: 'Alice', avatarUrl: null } },
      readAt: null,
      createdAt: '2026-11-12T10:00:00.000Z',
    };
    const r = route(env(notificationEvents.notificationUpsertedV1.type, { userId: B, notification }, [B]));
    expect(r.deliveries).toEqual([
      {
        to: { userIds: [B] },
        event: 'notification:new',
        message: expect.objectContaining({ data: { notification } }),
      },
    ]);
  });

  it('unknown events are ignored', () => {
    expect(route(env('template.greeting.created.v1', {}))).toEqual({ deliveries: [], effects: [] });
  });
});
