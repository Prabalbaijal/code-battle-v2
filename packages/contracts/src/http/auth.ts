import { z } from 'zod';

/** Platform roles (plan §16). `admin` implies every other role. */
export const ROLES = ['user', 'problem_setter', 'admin'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/** Cookie names. Both are httpOnly; the web app only checks for their presence. */
export const AUTH_COOKIES = {
  access: 'cb_at',
  refresh: 'cb_rt',
} as const;

/** Path the refresh cookie is scoped to (refresh + logout both need it). */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Custom header required on cookie-authenticated mutations (a cross-site form can't set it). */
export const CSRF_HEADER = 'x-cb-csrf';

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

/** Would collide with routes like `/users/search` or impersonate staff. Compared case-insensitively. */
export const RESERVED_USERNAMES = new Set([
  'search',
  'batch',
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'help',
  'api',
  'internal',
  'settings',
  'login',
  'logout',
  'register',
  'signup',
  'codebattle',
  'moderator',
  'null',
  'undefined',
]);

export const usernameSchema = z
  .string()
  .trim()
  .regex(USERNAME_RE, 'username must be 3–20 letters, digits or _')
  .refine((u) => !RESERVED_USERNAMES.has(u.toLowerCase()), 'this username is reserved');
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
/** Upper bound keeps Argon2 cost predictable; lower bound per OWASP. */
export const passwordSchema = z.string().min(8, 'password must be at least 8 characters').max(128);

export const registerBodySchema = z.object({
  username: usernameSchema,
  fullname: z.string().trim().min(1).max(60),
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
