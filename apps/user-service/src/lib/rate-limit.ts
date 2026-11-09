import { AppError } from '@cb/errors';
import type { RateLimiter } from '@cb/rate-limit';
import type { FastifyReply } from 'fastify';

/** Consume one token; 429 RATE_LIMITED with Retry-After when empty. */
export async function enforceLimit(reply: FastifyReply, limiter: RateLimiter, key: string): Promise<void> {
  const r = await limiter.consume(key);
  if (r.allowed) return;
  reply.header('retry-after', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
  throw new AppError('RATE_LIMITED', 429, 'Too many requests. Slow down.', {
    details: { retryAfterMs: r.retryAfterMs },
  });
}
