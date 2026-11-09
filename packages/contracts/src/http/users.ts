import { z } from 'zod';
import { pageSchema } from './common.js';

/** How the viewer relates to a profile (drives the Add / Pending / Accept / Friends button). */
export const RELATIONSHIPS = ['self', 'none', 'friends', 'outgoing', 'incoming'] as const;
export const relationshipSchema = z.enum(RELATIONSHIPS);
export type Relationship = z.infer<typeof relationshipSchema>;

export const profileSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  fullname: z.string(),
  /** null → the web app renders an initials avatar. */
  avatarUrl: z.string().nullable(),
  bio: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Profile = z.infer<typeof profileSchema>;

export const profileViewSchema = profileSchema.extend({
  /** Present when the request is authenticated. */
  relationship: relationshipSchema.optional(),
});
export type ProfileView = z.infer<typeof profileViewSchema>;

export const profilePageSchema = pageSchema(profileSchema);

export const updateProfileBodySchema = z
  .object({
    fullname: z.string().trim().min(1).max(60),
    bio: z.string().trim().max(280).nullable(),
    /** Must point at our Cloudinary avatar folder; null removes the avatar. */
    avatarUrl: z.url().max(500).nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'nothing to update');
export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(20),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Signed direct-to-Cloudinary upload (plan §16): the browser posts the file with these fields. */
export const avatarUploadSignatureSchema = z.object({
  uploadUrl: z.url(),
  fields: z.record(z.string(), z.string()),
  maxBytes: z.number().int(),
});
export type AvatarUploadSignature = z.infer<typeof avatarUploadSignatureSchema>;

export const friendRequestBodySchema = z.object({ toUserId: z.uuid() });

export const FRIEND_REQUEST_RESULTS = ['pending', 'accepted'] as const;
/** `accepted` when the other user had already asked us (mutual request = instant friends). */
export const friendRequestResultSchema = z.object({
  status: z.enum(FRIEND_REQUEST_RESULTS),
  user: profileSchema,
});

export const friendSchema = profileSchema.extend({ since: z.iso.datetime() });
export const friendPageSchema = pageSchema(friendSchema);

export const friendRequestSchema = z.object({
  user: profileSchema,
  direction: z.enum(['incoming', 'outgoing']),
  createdAt: z.iso.datetime(),
});
export const friendRequestPageSchema = pageSchema(friendRequestSchema);
export const friendRequestsQuerySchema = z.object({
  direction: z.enum(['incoming', 'outgoing']).default('incoming'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
