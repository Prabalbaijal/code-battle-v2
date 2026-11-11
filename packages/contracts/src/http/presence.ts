import { z } from 'zod';
import { PRESENCE_STATUSES } from '../socket/index.js';

export const presenceStatusSchema = z.enum(PRESENCE_STATUSES);

/** A player in the lobby's "online players" list (plan §13.3). */
export const onlinePlayerSchema = z.object({
  userId: z.uuid(),
  username: z.string(),
  fullname: z.string(),
  avatarUrl: z.string().nullable(),
  status: presenceStatusSchema,
});
export type OnlinePlayer = z.infer<typeof onlinePlayerSchema>;

export const onlinePageSchema = z.object({
  items: z.array(onlinePlayerSchema),
  nextCursor: z.string().nullable(),
});

export const presenceQueryBodySchema = z.object({ userIds: z.array(z.uuid()).min(1).max(100) });
export const presenceQueryResultSchema = z.object({
  statuses: z.record(z.string(), presenceStatusSchema),
});
export type PresenceQueryResult = z.infer<typeof presenceQueryResultSchema>;
