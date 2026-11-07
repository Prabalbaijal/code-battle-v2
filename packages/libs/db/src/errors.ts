/** Postgres SQLSTATE codes we act on. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

interface PgLikeError {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

/** Find the underlying pg error (drizzle wraps driver errors in `cause`). */
function findPgError(err: unknown): PgLikeError | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const e = cur as PgLikeError;
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    cur = e.cause;
  }
  return undefined;
}

export const pgErrorCode = (err: unknown): string | undefined => findPgError(err)?.code;

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = findPgError(err);
  return e?.code === PG.uniqueViolation && (constraint === undefined || e.constraint === constraint);
}

export const isRetryableTxError = (err: unknown): boolean => {
  const code = pgErrorCode(err);
  return code === PG.serializationFailure || code === PG.deadlockDetected;
};
