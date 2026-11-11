import { z } from 'zod';
import { TOPICS, defineEvent } from './envelope.js';

/** rating-service events on `rating.events`, keyed by userId. */
export const statsChangedV1 = defineEvent(
  TOPICS.rating,
  'rating.stats.changed.v1',
  z.object({
    userId: z.uuid(),
    coins: z.number().int(),
    level: z.number().int(),
    wins: z.number().int(),
    losses: z.number().int(),
    draws: z.number().int(),
    streak: z.number().int(),
    bestStreak: z.number().int(),
    /** The real change (after the floor at 0); the signup bonus for a new player; 0 for a visibility change. */
    delta: z.number().int(),
    reason: z.string(),
    matchId: z.uuid().nullable(),
    /** Not on the leaderboard (admins). */
    hidden: z.boolean(),
    updatedAt: z.iso.datetime(),
  }),
);
