import { createLogger } from '@cb/logger';
import { createRedis, SafeRedis, waitForReady, type Redis } from '@cb/redis';
import { startRedis, type Started } from '@cb/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from './index.js';

const logger = createLogger({ service: 'rl-int', level: 'silent' });
let rc: Started<{ url: string }>;
let redis: Redis;

beforeAll(async () => {
  rc = await startRedis();
  redis = createRedis({ url: rc.value.url, role: 'cache', logger });
  await waitForReady(redis);
}, 120_000);
afterAll(async () => {
  redis?.disconnect();
  await rc?.stop();
});

describe('RateLimiter (redis)', () => {
  it('shares one bucket across limiter instances and refills', async () => {
    const mk = () =>
      new RateLimiter({ redis: new SafeRedis(redis, logger), prefix: 'test', capacity: 3, refillPerSec: 10 });
    const a = mk();
    const b = mk();
    const results = await Promise.all([a.consume('u1'), b.consume('u1'), a.consume('u1'), b.consume('u1')]);
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    const denied = results.find((r) => !r.allowed)!;
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(100);
    await new Promise((r) => setTimeout(r, 150));
    expect((await a.consume('u1')).allowed).toBe(true);
  });

  it('falls back to memory when redis is unavailable', async () => {
    const dead = createRedis({ url: 'redis://127.0.0.1:1', role: 'cache', logger });
    const rl = new RateLimiter({
      redis: new SafeRedis(dead, logger),
      prefix: 'x',
      capacity: 2,
      refillPerSec: 1,
    });
    expect((await rl.consume('k')).allowed).toBe(true);
    expect((await rl.consume('k')).allowed).toBe(true);
    expect((await rl.consume('k')).allowed).toBe(false);
    dead.disconnect();
  });
});
