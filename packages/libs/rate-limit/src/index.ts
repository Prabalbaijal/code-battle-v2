import type { Logger } from '@cb/logger';
import type { SafeRedis } from '@cb/redis';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** 0 when allowed; otherwise ms until `cost` tokens are available. */
  retryAfterMs: number;
}

export interface BucketConfig {
  /** Max burst. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

/** Per-process token bucket. Used directly in tests and as the fallback when Redis is down. */
export class InMemoryTokenBucket {
  private readonly buckets = new Map<string, { tokens: number; ts: number }>();

  constructor(
    private readonly cfg: BucketConfig,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string, cost = 1): RateLimitResult {
    const now = this.now();
    const refillPerMs = this.cfg.refillPerSec / 1000;
    const b = this.buckets.get(key) ?? { tokens: this.cfg.capacity, ts: now };
    const tokens = Math.min(this.cfg.capacity, b.tokens + Math.max(0, now - b.ts) * refillPerMs);
    if (this.buckets.size > 50_000) this.buckets.clear(); // crude memory cap for the fallback path
    if (tokens >= cost) {
      this.buckets.set(key, { tokens: tokens - cost, ts: now });
      return { allowed: true, remaining: Math.floor(tokens - cost), retryAfterMs: 0 };
    }
    this.buckets.set(key, { tokens, ts: now });
    return {
      allowed: false,
      remaining: Math.floor(tokens),
      retryAfterMs: Math.ceil((cost - tokens) / refillPerMs),
    };
  }
}

/** Atomic token bucket in Redis; uses Redis TIME so instances with skewed clocks agree. */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', key, 't', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / refill)
end
redis.call('HSET', key, 't', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, math.ceil(capacity / refill) + 1000)
return {allowed, math.floor(tokens), retry}
`;

export interface RateLimiterOptions extends BucketConfig {
  redis: SafeRedis;
  prefix: string;
  logger?: Logger;
  /** When falling back to memory, each instance allows capacity/divisor (≈ number of instances). */
  fallbackDivisor?: number;
}

/** Distributed limiter with in-memory fallback (plan §17.2, §18.1). */
export class RateLimiter {
  private readonly fallback: InMemoryTokenBucket;

  constructor(private readonly o: RateLimiterOptions) {
    const d = Math.max(1, o.fallbackDivisor ?? 1);
    this.fallback = new InMemoryTokenBucket({ capacity: o.capacity / d, refillPerSec: o.refillPerSec / d });
  }

  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    const fullKey = `rl:${this.o.prefix}:${key}`;
    return this.o.redis.run(
      async (r) => {
        const res = (await r.eval(
          TOKEN_BUCKET_LUA,
          1,
          fullKey,
          this.o.capacity,
          this.o.refillPerSec / 1000,
          cost,
        )) as [number, number, number];
        return { allowed: res[0] === 1, remaining: res[1], retryAfterMs: res[2] };
      },
      () => this.fallback.consume(fullKey, cost),
    );
  }
}
