export interface RetryOptions {
  /** Retries after the first attempt (total attempts = retries + 1). */
  retries: number;
  baseMs?: number;
  maxMs?: number;
  /** Return false to stop retrying (e.g. 4xx). Default: always retry. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Override the computed delay (e.g. honour Retry-After). */
  delayFor?: (err: unknown, attempt: number) => number | undefined;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "Full jitter" backoff: random(0, min(max, base·2^attempt)). Avoids synchronized retry storms. */
export function backoffDelay(attempt: number, baseMs = 100, maxMs = 10_000, random = Math.random): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * cap);
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const doSleep = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const canRetry = attempt < opts.retries && (opts.shouldRetry?.(err, attempt) ?? true);
      if (!canRetry) throw err;
      const delay =
        opts.delayFor?.(err, attempt) ?? backoffDelay(attempt, opts.baseMs, opts.maxMs, opts.random);
      opts.onRetry?.(err, attempt + 1, delay);
      await doSleep(delay);
    }
  }
}
