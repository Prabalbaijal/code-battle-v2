import { z } from 'zod';
import {
  EMAIL_MAX_LENGTH,
  FULLNAME_MAX_LENGTH,
  isReservedUsername,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  ROLES,
  USERNAME_HINT,
  USERNAME_RE,
} from '../constants.js';

// Re-exported for server code that imports everything from '@cb/contracts'.
export {
  AUTH_COOKIES,
  CSRF_HEADER,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  REFRESH_COOKIE_PATH,
  RESERVED_USERNAMES,
  ROLES,
  USERNAME_RE,
} from '../constants.js';

export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const usernameSchema = z
  .string()
  .trim()
  .regex(USERNAME_RE, USERNAME_HINT)
  .refine((u) => !isReservedUsername(u), 'this username is reserved');
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .pipe(z.string().max(EMAIL_MAX_LENGTH));
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

export const registerBodySchema = z.object({
  username: usernameSchema,
  fullname: z.string().trim().min(1).max(FULLNAME_MAX_LENGTH),
  email: emailSchema,
  password: passwordSchema,
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

/** v1 logged in by username; v2 accepts username or email. */
export const loginBodySchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const tokenBodySchema = z.object({ token: z.string().min(16).max(128) });
export const forgotPasswordBodySchema = z.object({ email: emailSchema });
export const resetPasswordBodySchema = z.object({
  token: z.string().min(16).max(128),
  password: passwordSchema,
});

export const meSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  fullname: z.string(),
  email: z.string(),
  role: roleSchema,
  emailVerified: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Me = z.infer<typeof meSchema>;

/** Body returned by login and refresh (tokens travel in cookies). */
export const sessionSchema = z.object({
  user: meSchema,
  accessTokenExpiresAt: z.iso.datetime(),
});
export type Session = z.infer<typeof sessionSchema>;

export const socketTicketSchema = z.object({ ticket: z.string(), url: z.string() });
export type SocketTicket = z.infer<typeof socketTicketSchema>;
