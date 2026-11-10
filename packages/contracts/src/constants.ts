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

/**
 * CPU time multiplier per language vs C++ (plan §9.5), used for default limits and for languages
 * without their own accepted reference solution during calibration (plan §14.7).
 */
export const LANGUAGE_TIME_FACTORS: Record<LanguageKey, number> = {
  cpp: 1.0,
  java: 2.0,
  python: 3.0,
  javascript: 1.5,
};

/** Problem authoring limits: the API's zod schemas and the admin forms both read these. */
export const PROBLEM_LIMITS = {
  slug: { min: 3, max: 80 },
  title: { min: 3, max: 120 },
  statementMd: 20_000,
  formatMd: 5_000,
  constraints: { count: 20, length: 300 },
  examples: { min: 1, max: 10, text: 4_000, explanation: 2_000 },
  tags: { count: 10, length: 30 },
  memoryKb: { min: 16 * 1024, max: 256 * 1024, default: 192 * 1024 },
  outputKb: { min: 64, max: 4 * 1024, default: 1024 },
  /** Test files 1–4 (plan §14.2); judge-core enforces the same byte limits. */
  testFiles: 4,
  testInputBytes: 2 * 1024 * 1024,
  testOutputBytes: 512 * 1024,
} as const;

export const PACK_KINDS = ['sample', 'small', 'large'] as const;
export type PackKind = (typeof PACK_KINDS)[number];
export const CHECKER_TYPES = ['tokens', 'float', 'exact'] as const;
export type CheckerType = (typeof CHECKER_TYPES)[number];
export const REFERENCE_VERDICTS = ['AC', 'TLE', 'WA'] as const;
export type ReferenceVerdict = (typeof REFERENCE_VERDICTS)[number];

/**
 * CPU time a trivial program needs per language on hosted Judge0 CE 1.14 (RapidAPI), measured
 * 2026-11-11: cpp 3 ms, java 82 ms, python 972 ms (conda wrapper), javascript 1038 ms. Calibration
 * adds it to limits it derives from C++ (plan §14.7); re-measure when switching Judge0 instances.
 */
export const LANGUAGE_STARTUP_MS: Record<LanguageKey, number> = {
  cpp: 0,
  java: 100,
  python: 1000,
  javascript: 1050,
};
