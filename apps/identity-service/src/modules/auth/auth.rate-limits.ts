import { AppError } from '@cb/errors';
import type { Logger } from '@cb/logger';
import { RateLimiter } from '@cb/rate-limit';
import type { SafeRedis } from '@cb/redis';
import type { FastifyReply } from 'fastify';

/**
 * Per-route limits inside identity (defence in depth; the gateway has its own coarse limits).
 * Plan §16: login 5/min per IP+account and 20/min per IP. Redis-backed with in-memory fallback.
 */
export function createAuthRateLimits(redis: SafeRedis, logger: Logger) {
  const per = (prefix: string, capacity: number, windowSec: number) =>
    new RateLimiter({
      redis,
      logger,
      prefix: `identity:${prefix}`,
      capacity,
      refillPerSec: capacity / windowSec,
    });
  return {
    loginIp: per('login-ip', 20, 60),
    loginAccount: per('login-acct', 5, 60),
    registerIp: per('register-ip', 10, 3600),
    /** forgot-password + resend-verification */
    emailIp: per('email-ip', 10, 3600),
    emailAccount: per('email-acct', 3, 3600),
    /** refresh, verify-email, reset-password */
    tokenIp: per('token-ip', 60, 60),
  };
}

export type AuthRateLimits = ReturnType<typeof createAuthRateLimits>;

/** Consume one token from each limiter; 429 with Retry-After on the first one that is empty. */
export async function enforceLimits(reply: FastifyReply, ...checks: [RateLimiter, string][]): Promise<void> {
  for (const [limiter, key] of checks) {
    const r = await limiter.consume(key);
    if (!r.allowed) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
      throw new AppError('RATE_LIMITED', 429, 'Too many requests. Slow down.', {
        details: { retryAfterMs: r.retryAfterMs },
      });
    }
  }
}
