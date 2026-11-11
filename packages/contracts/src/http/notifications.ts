import { z } from 'zod';
import { challengeStatusSchema, matchHistoryItemSchema, playerSchema } from './battle.js';
import { pageSchema } from './common.js';
import { playerStatsSchema } from './rating.js';
import { profileViewSchema } from './users.js';

/** Plan §8.8: in-app notifications (the v1 notification panel: friend requests and challenges). */
export const NOTIFICATION_TYPES = [
  'friend_request',
  'friend_accepted',
  'challenge_received',
  'match_result',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const base = { id: z.uuid(), readAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime() };

export const notificationSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('friend_request'), payload: z.object({ from: playerSchema }) }),
  z.object({ ...base, type: z.literal('friend_accepted'), payload: z.object({ by: playerSchema }) }),
  z.object({
    ...base,
    type: z.literal('challenge_received'),
    payload: z.object({
      challengeId: z.uuid(),
      from: playerSchema,
      expiresAt: z.iso.datetime(),
      /** `expired` while still unread = a missed challenge. */
      status: challengeStatusSchema,
    }),
  }),
  z.object({
    ...base,
    type: z.literal('match_result'),
    // filled from two events (battle's result, rating's coin change) in either order
    payload: z.object({
      matchId: z.uuid(),
      result: z.enum(['win', 'loss', 'draw']).nullable().default(null),
      endReason: z.enum(['solved', 'forfeit', 'timeout']).nullable().default(null),
      opponent: playerSchema.nullable().default(null),
      coinDelta: z.number().nullable().default(null),
    }),
  }),
]);
export type Notification = z.infer<typeof notificationSchema>;

export const notificationPageSchema = pageSchema(notificationSchema);
export const unreadCountSchema = z.object({ count: z.number() });

// ---------------- profile BFF (gateway, plan §8.1) ----------------

/** A finished match with what it really did to the player's coins (v1 bug #21). */
export const historyItemSchema = matchHistoryItemSchema.extend({ coinDelta: z.number().nullable() });
export type HistoryItem = z.infer<typeof historyItemSchema>;
export const historyPageSchema = pageSchema(historyItemSchema);
export type HistoryPage = z.infer<typeof historyPageSchema>;

/** GET /api/v1/bff/profile/:username. `stats` is null when rating-service can't answer. */
export const profilePageViewSchema = z.object({
  profile: profileViewSchema,
  stats: playerStatsSchema.nullable(),
  isMe: z.boolean(),
  /** Only on your own profile (match history is private). */
  history: historyPageSchema.nullable(),
});
export type ProfilePageView = z.infer<typeof profilePageViewSchema>;
