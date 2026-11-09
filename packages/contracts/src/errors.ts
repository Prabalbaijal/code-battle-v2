import { z } from 'zod';

/**
 * Every error code the platform can return. Clients switch on `code`, never on messages.
 * Add new codes here (append-only) — removing one is a breaking API change.
 */
export const ERROR_CODES = [
  // generic
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'UPSTREAM_ERROR',
  'CIRCUIT_OPEN',
  // idempotency
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'REQUEST_IN_PROGRESS',
  // identity
  'EMAIL_TAKEN',
  'USERNAME_TAKEN',
  'INVALID_CREDENTIALS',
  'EMAIL_NOT_VERIFIED',
  'ACCOUNT_LOCKED',
  'TOKEN_INVALID',
  // social
  'FRIEND_REQUEST_EXISTS',
  'ALREADY_FRIENDS',
  // battle
  'OPPONENT_OFFLINE',
  'USER_IN_ACTIVE_MATCH',
  'CHALLENGE_ALREADY_PENDING',
  'CHALLENGE_NOT_PENDING',
  'MATCH_NOT_ACTIVE',
  'NO_UNSEEN_PROBLEM',
  // judge
  'JUDGE_AT_CAPACITY',
  'SUBMISSION_LIMIT_REACHED',
  'CODE_UNCHANGED',
  // ai
  'AI_DISABLED',
  'AI_BUDGET_EXHAUSTED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export const errorCodeSchema = z.enum(ERROR_CODES);

/** Body of every non-2xx JSON response. */
export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
