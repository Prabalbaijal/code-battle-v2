import type { ErrorBody, ErrorCode } from '@cb/contracts';
import { CSRF_HEADER, IDEMPOTENCY_HEADER } from '@cb/contracts/constants';

/** A non-2xx response from the API, with the platform error code (plan §7.2). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isApiError = (e: unknown, code?: ApiError['code']): e is ApiError =>
  e instanceof ApiError && (code === undefined || e.code === code);

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** `true` generates one key per call; the same key is reused if the request is retried. */
  idempotent?: boolean;
  signal?: AbortSignal;
}

/** These manage the session themselves; a 401 from them must not trigger a refresh. */
const NO_REFRESH = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Tests swap the transport. */
export const setFetch = (f: Fetch) => {
  fetchImpl = f;
};

let refreshing: Promise<boolean> | null = null;

/**
 * Rotate the session once, however many requests hit 401 at the same time (single flight).
 * A 409 means another tab rotated first; its new cookies are already in the jar, so retrying is fine.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetchImpl('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { [CSRF_HEADER]: '1' },
        credentials: 'same-origin',
      });
      return r.ok || r.status === 409;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Shape check for `{ error: { code, message } }` (no zod in the browser bundle). */
function isErrorBody(v: unknown): v is ErrorBody {
  if (typeof v !== 'object' || v === null) return false;
  const e = (v as { error?: unknown }).error;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}

async function toError(res: Response): Promise<ApiError> {
  const json: unknown = await res.json().catch(() => null);
  if (isErrorBody(json)) {
    const { code, message, details } = json.error;
    return new ApiError(res.status, code, message, details);
  }
  return new ApiError(
    res.status,
    res.status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
    res.statusText || 'Request failed',
  );
}

/**
 * Same-origin call to the gateway through the Next rewrite (`/api/v1/...`). Cookies carry the
 * session; mutations send the CSRF header. An expired access token is refreshed once and retried.
 */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  if (opts.idempotent) headers[IDEMPOTENCY_HEADER] = crypto.randomUUID();

  const send = () =>
    fetchImpl(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && !NO_REFRESH.some((p) => path.startsWith(p)) && (await refreshSession())) {
      res = await send();
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error. Check your connection.');
  }

  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Friendly text for an error code, for places that don't map codes to specific fields. */
export function messageFor(err: unknown): string {
  if (!isApiError(err)) return 'Something went wrong. Please try again.';
  switch (err.code) {
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a minute and try again.';
    case 'NETWORK_ERROR':
      return err.message;
    case 'SERVICE_UNAVAILABLE':
    case 'UPSTREAM_ERROR':
    case 'INTERNAL_ERROR':
      return 'The server is having trouble. Please try again shortly.';
    default:
      return err.message;
  }
}
