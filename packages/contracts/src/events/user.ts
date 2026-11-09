import { z } from 'zod';
import { TOPICS, defineEvent } from './envelope.js';

/**
 * user-service events on `user.events`. Friendship events are keyed by `userLow` (plan §10.2), so
 * every change to one pair stays in order.
 */
export const FRIENDSHIP_CHANGES = ['requested', 'accepted', 'rejected', 'cancelled', 'removed'] as const;

export const friendshipChangedV1 = defineEvent(
  TOPICS.user,
  'user.friendship.changed.v1',
  z.object({
    userLow: z.uuid(),
    userHigh: z.uuid(),
    change: z.enum(FRIENDSHIP_CHANGES),
    /** Who did it. */
    actorId: z.uuid(),
    /** The other user (who gets notified). */
    targetId: z.uuid(),
    at: z.iso.datetime(),
  }),
);

export const profileUpdatedV1 = defineEvent(
  TOPICS.user,
  'user.profile.updated.v1',
  z.object({
    userId: z.uuid(),
    username: z.string(),
    fullname: z.string(),
    avatarUrl: z.string().nullable(),
    bio: z.string().nullable(),
    updatedAt: z.iso.datetime(),
  }),
);
