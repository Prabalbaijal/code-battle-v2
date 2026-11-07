import { createLogger } from '@cb/logger';
import { startPostgres, waitFor, type Started } from '@cb/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { isUniqueViolation } from './errors.js';
import { startLeaderLoop } from './leader.js';
import { withTransaction } from './transaction.js';

const logger = createLogger({ service: 'db-int', level: 'silent' });
let pgC: Started<{ url: string }>;
let h: DbHandle;

beforeAll(async () => {
  pgC = await startPostgres();
  h = createDb({ connectionString: pgC.value.url, max: 10 });
  await h.db.execute(sql`create table t (id int primary key, v int not null)`);
}, 120_000);
afterAll(async () => {
  await h?.close();
  await pgC?.stop();
});

describe('db', () => {
  it('detects unique violations through drizzle errors', async () => {
    await h.db.execute(sql`insert into t values (1, 0)`);
    const err = await h.db.execute(sql`insert into t values (1, 0)`).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('retries serializable transactions on conflicts', async () => {
    await h.db.execute(sql`insert into t values (2, 0)`);
    const inc = () =>
      withTransaction(
        h.db,
        async (tx) => {
          const r = await tx.execute<{ v: number }>(sql`select v from t where id = 2`);
          await new Promise((res) => setTimeout(res, 20));
          await tx.execute(sql`update t set v = ${Number(r.rows[0]!.v) + 1} where id = 2`);
        },
        { isolationLevel: 'serializable', retries: 10 },
      );
    await Promise.all(Array.from({ length: 5 }, inc));
    const r = await h.db.execute<{ v: number }>(sql`select v from t where id = 2`);
    expect(Number(r.rows[0]!.v)).toBe(5); // no lost updates
  });

  it('elects exactly one leader and fails over when it stops', async () => {
    const ticks = { a: 0, b: 0 };
    const a = startLeaderLoop({
      pool: h.pool,
      name: 'reconciler',
      intervalMs: 50,
      logger,
      task: async () => void ticks.a++,
    });
    const b = startLeaderLoop({
      pool: h.pool,
      name: 'reconciler',
      intervalMs: 50,
      logger,
      task: async () => void ticks.b++,
    });
    await waitFor(async () => a.isLeader() || b.isLeader(), { what: 'a leader' });
    await new Promise((r) => setTimeout(r, 300));
    expect(a.isLeader() && b.isLeader()).toBe(false);
    const [leader, follower] = a.isLeader() ? [a, b] : [b, a];
    await leader.stop();
    await waitFor(async () => follower.isLeader(), { what: 'failover' });
    await follower.stop();
    expect(ticks.a + ticks.b).toBeGreaterThan(0);
  });
});
