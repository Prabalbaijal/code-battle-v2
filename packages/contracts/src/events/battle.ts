import { z } from 'zod';
import { TOPICS, defineEvent } from './envelope.js';

/**
 * battle-service events on `battle.events`, keyed by challengeId or matchId so each one stays in
 * order. Every event names its `recipients` in the envelope; realtime delivers to exactly those.
 */
const challengeBase = {
  challengeId: z.uuid(),
  fromUserId: z.uuid(),
  toUserId: z.uuid(),
};

export const challengeCreatedV1 = defineEvent(
  TOPICS.battle,
  'battle.challenge.created.v1',
  z.object({
    ...challengeBase,
    expiresAt: z.iso.datetime(),
    /** Shown in the recipient's notification without another lookup. */
    from: z.object({ username: z.string(), fullname: z.string(), avatarUrl: z.string().nullable() }),
  }),
);
export const challengeAcceptedV1 = defineEvent(
  TOPICS.battle,
  'battle.challenge.accepted.v1',
  z.object({ ...challengeBase, matchId: z.uuid() }),
);
export const challengeRejectedV1 = defineEvent(
  TOPICS.battle,
  'battle.challenge.rejected.v1',
  z.object(challengeBase),
);
export const challengeCancelledV1 = defineEvent(
  TOPICS.battle,
  'battle.challenge.cancelled.v1',
  z.object(challengeBase),
);
export const challengeExpiredV1 = defineEvent(
  TOPICS.battle,
  'battle.challenge.expired.v1',
  z.object(challengeBase),
);

export const matchStartedV1 = defineEvent(
  TOPICS.battle,
  'battle.match.started.v1',
  z.object({
    matchId: z.uuid(),
    problemId: z.uuid(),
    userIds: z.array(z.uuid()),
    startedAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
  }),
);
export const matchDecidingV1 = defineEvent(
  TOPICS.battle,
  'battle.match.deciding.v1',
  z.object({ matchId: z.uuid(), userIds: z.array(z.uuid()), decideDeadline: z.iso.datetime() }),
);
export const matchCompletedV1 = defineEvent(
  TOPICS.battle,
  'battle.match.completed.v1',
  z.object({
    matchId: z.uuid(),
    problemId: z.uuid(),
    userIds: z.array(z.uuid()),
    winnerId: z.uuid().nullable(),
    endReason: z.enum(['solved', 'forfeit', 'timeout']),
    results: z.record(z.string(), z.enum(['win', 'loss', 'draw'])),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
  }),
);
export const matchAbortedV1 = defineEvent(
  TOPICS.battle,
  'battle.match.aborted.v1',
  z.object({
    matchId: z.uuid(),
    userIds: z.array(z.uuid()),
    /** Why, in words the UI can show (e.g. no new problems for this pair). */
    reason: z.string(),
  }),
);
