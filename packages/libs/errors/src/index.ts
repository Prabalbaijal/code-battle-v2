import type { ErrorCode } from '@cb/contracts';

export interface AppErrorOptions {
  details?: unknown;
  cause?: unknown;
  /** Whether `message` is safe to show to clients. 5xx default to false. */
  expose?: boolean;
}

/**
 * The only error type services throw on purpose. The HTTP error mapper turns it into
 * `{ error: { code, message, details, requestId } }` with `status`.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly expose: boolean;

  constructor(code: ErrorCode, status: number, message: string, opts: AppErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = opts.details;
    this.expose = opts.expose ?? status < 500;
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

export const badRequest = (message: string, details?: unknown) =>
  new AppError('BAD_REQUEST', 400, message, { details });
export const unauthorized = (message = 'Authentication required') =>
  new AppError('UNAUTHORIZED', 401, message);
export const forbidden = (message = 'Forbidden') => new AppError('FORBIDDEN', 403, message);
export const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} not found`);
export const conflict = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(code, 409, message, { details });
export const unavailable = (code: ErrorCode, message: string) =>
  new AppError(code, 503, message, { expose: true });
export const internal = (message: string, cause?: unknown) =>
  new AppError('INTERNAL_ERROR', 500, message, { cause });
