import { describe, expect, it } from 'vitest';
import { readEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/judge',
  REDIS_URL: 'redis://localhost:6379',
  KAFKA_BROKERS: 'localhost:19092',
  JWKS_URL: 'http://localhost:4001/.well-known/jwks.json',
  INTERNAL_SERVICE_SECRET: 's'.repeat(40),
};

describe('judge env', () => {
  it('refuses a match reserve that leaves practice no budget', () => {
    expect(() => readEnv({ ...base, JUDGE0_DAILY_BUDGET: '20' })).toThrow(/MATCH_RESERVE_CALLS/);
    expect(
      readEnv({ ...base, JUDGE0_DAILY_BUDGET: '20', MATCH_RESERVE_CALLS: '5' }).MATCH_RESERVE_CALLS,
    ).toBe(5);
  });
});
