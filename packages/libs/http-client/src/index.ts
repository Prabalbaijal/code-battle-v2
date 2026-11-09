import { AppError } from '@cb/errors';
import { CircuitBreaker, retry } from '@cb/resilience';
import type { z } from 'zod';

/** Thrown for non-2xx upstream responses, network errors and timeouts. Maps to 502 by default. */
export class UpstreamError extends AppError {
  constructor(
    readonly upstream: string,
    readonly upstreamStatus: number | undefined,
    message: string,
    readonly body?: unknown,
    readonly retryAfterMs?: number,
  ) {
    super('UPSTREAM_ERROR', 502, message, { details: { upstream, upstreamStatus } });
    this.name = 'UpstreamError';
  }
  /** Network error, timeout, 5xx or 429. */
  get retryable(): boolean {
    return this.upstreamStatus === undefined || this.upstreamStatus >= 500 || this.upstreamStatus === 429;
  }
}

export interface HttpClientOptions {
  name: string;
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  /** Pass `false` to disable. Default: opens after 5 consecutive retryable failures for 30 s. */
  breaker?: CircuitBreaker | false;
  headers?: Record<string, string> | (() => Record<string, string>);
  fetchImpl?: typeof fetch;
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  schema?: z.ZodType<T>;
  /** Retry this request? Default: true for GET/PUT/DELETE, false for POST/PATCH (not idempotent). */
  retry?: boolean;
  timeoutMs?: number;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Service-to-service HTTP: timeout, retry with full jitter (honours Retry-After), circuit breaker, zod. */
export function createHttpClient(opts: HttpClientOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const breaker =
    opts.breaker === false
      ? undefined
      : (opts.breaker ??
        new CircuitBreaker({
          name: opts.name,
          isFailure: (e) => !(e instanceof UpstreamError) || e.retryable,
        }));

  async function once<T>(req: RequestOptions<T>): Promise<HttpResponse<T>> {
    const url = new URL(
      req.path.replace(/^\//, ''),
      opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`,
    );
    for (const [k, v] of Object.entries(req.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const baseHeaders = typeof opts.headers === 'function' ? opts.headers() : (opts.headers ?? {});
    let res: Response;
    try {
      res = await doFetch(url, {
        method: req.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...baseHeaders,
          ...req.headers,
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(req.timeoutMs ?? opts.timeoutMs ?? 5000),
      });
    } catch (err) {
      throw new UpstreamError(opts.name, undefined, `${opts.name} request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    let body: unknown = text;
    if (text && res.headers.get('content-type')?.includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    if (!res.ok) {
      throw new UpstreamError(
        opts.name,
        res.status,
        `${opts.name} responded ${res.status}`,
        body,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    const data = req.schema ? req.schema.parse(body) : (body as T);
    return { status: res.status, data, headers: res.headers };
  }

  async function request<T = unknown>(req: RequestOptions<T>): Promise<HttpResponse<T>> {
    const method = req.method ?? 'GET';
    const canRetry = req.retry ?? (method === 'GET' || method === 'PUT' || method === 'DELETE');
    const call = () => (breaker ? breaker.exec(() => once(req)) : once(req));
    return retry(call, {
      retries: canRetry ? (opts.retries ?? 2) : 0,
      baseMs: 100,
      maxMs: 2000,
      shouldRetry: (e) => e instanceof UpstreamError && e.retryable,
      delayFor: (e) => (e instanceof UpstreamError ? e.retryAfterMs : undefined),
    });
  }

  return { request, breaker };
}

export type HttpClient = ReturnType<typeof createHttpClient>;
