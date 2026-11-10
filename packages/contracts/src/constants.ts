/**
 * Zod-free constants. Browser code imports runtime values from `@cb/contracts/constants` (zod's
 * classic API doesn't tree-shake, ~45 KB gzip) and only types from `@cb/contracts`. The zod schemas
 * in the rest of this package are built from these, so client and server rules can't drift.
 */

/** Platform roles (plan §16). `admin` implies every other role. */
export const ROLES = ['user', 'problem_setter', 'admin'] as const;

/** Cookie names. Tokens are httpOnly; `session` is a readable hint (no secret in it). */
export const AUTH_COOKIES = {
  access: 'cb_at',
  refresh: 'cb_rt',
  /**
   * Session hint (value "1", path "/", lives as long as the refresh token). The refresh cookie is
   * scoped to /api/v1/auth, so page middleware can't see it; this tells it a session may exist.
   * Readable by JS so the web app can skip `/auth/me` for anonymous visitors. Never trusted for
   * authorization.
   */
  session: 'cb_s',
} as const;

/** Path the refresh cookie is scoped to (refresh + logout both need it). */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Custom header required on cookie-authenticated mutations (a cross-site form can't set it). */
export const CSRF_HEADER = 'x-cb-csrf';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REQUEST_ID_HEADER = 'x-request-id';

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
export const USERNAME_HINT = 'username must be 3–20 letters, digits or _';

/** Would collide with routes like `/users/search` or impersonate staff. Compared case-insensitively. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
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

export const isReservedUsername = (u: string) => RESERVED_USERNAMES.has(u.trim().toLowerCase());

/** Lower bound per OWASP; upper bound keeps Argon2 cost predictable. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const FULLNAME_MAX_LENGTH = 60;
export const EMAIL_MAX_LENGTH = 254;

/** Languages offered in battles (plan §14.1). Judge0 ids are resolved from /languages at boot. */
export const LANGUAGE_KEYS = ['cpp', 'java', 'python', 'javascript'] as const;
export type LanguageKey = (typeof LANGUAGE_KEYS)[number];

export const DIFFICULTIES = ['Easy', 'Medium', 'Hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Problem slugs: lowercase words joined by hyphens, e.g. "two-sum". */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Source code limit (plan §7.3: submissions 64 KB). */
export const MAX_CODE_BYTES = 64 * 1024;
