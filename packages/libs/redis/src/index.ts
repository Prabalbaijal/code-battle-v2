import type { Logger } from '@cb/logger';
import { CircuitBreaker } from '@cb/resilience';
import { Redis, type RedisOptions } from 'ioredis';

export { Redis };

/**
 * cache/presence: fail fast (no offline queue, 150 ms command timeout) so callers can fall back.
 * queue: BullMQ requirements (maxRetriesPerRequest: null). Plan §18.1.
 */
export type RedisRole = 'cache' | 'presence' | 'queue';

export interface CreateRedisOptions {
  url: string;
  role: RedisRole;
  logger: Logger;
  name?: string;
}

export function createRedis(opts: CreateRedisOptions): Redis {
  const base: RedisOptions = {
    connectionName: opts.name,
    retryStrategy: (times) => Math.min(200 * times, 2000),
  };
  const roleOpts: RedisOptions =
    opts.role === 'queue'
      ? { maxRetriesPerRequest: null, enableReadyCheck: true }
      : { enableOfflineQueue: false, commandTimeout: 150, maxRetriesPerRequest: 1 };
  const client = new Redis(opts.url, { ...base, ...roleOpts });

  let lastLog = 0;
  client.on('error', (err) => {
    const now = Date.now();
    if (now - lastLog > 10_000) {
      lastLog = now;
      opts.logger.warn({ err: err.message, role: opts.role }, 'redis error');
    }
  });
  return client;
}

export function waitForReady(client: Redis, timeoutMs = 5000): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('redis not ready')), timeoutMs);
    client.once('ready', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Redis with graceful degradation: every call goes through a circuit breaker and has a fallback.
 * When Redis is down we stop waiting on timeouts (breaker open) and use the fallback immediately.
 */
export class SafeRedis {
  private readonly breaker: CircuitBreaker;

  constructor(
    readonly client: Redis,
    private readonly logger: Logger,
    opts: { failureThreshold?: number; resetTimeoutMs?: number } = {},
  ) {
    this.breaker = new CircuitBreaker({
      name: 'redis',
      failureThreshold: opts.failureThreshold ?? 5,
      resetTimeoutMs: opts.resetTimeoutMs ?? 10_000,
      onStateChange: (from, to) => logger.warn({ from, to }, 'redis circuit state change'),
    });
  }

  get available(): boolean {
    return this.client.status === 'ready' && !this.breaker.isOpen;
  }

  async run<T>(fn: (r: Redis) => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
    if (this.client.status !== 'ready') return fallback();
    try {
      return await this.breaker.exec(() => fn(this.client));
    } catch (err) {
      this.logger.debug({ err }, 'redis call failed, using fallback');
      return fallback();
    }
  }

  ping = async (): Promise<boolean> => (await this.client.ping().catch(() => null)) === 'PONG';
}
