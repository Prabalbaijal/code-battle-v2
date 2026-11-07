import { createDb, withTransaction, type DbHandle } from '@cb/db';
import { createLogger } from '@cb/logger';
import { createRedis, waitForReady, type Redis } from '@cb/redis';
import { createTables, startPostgres, startRedis, waitFor, type Started } from '@cb/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobOutboxDispatcher, addJobToOutbox } from './job-outbox.js';
import { createQueue, createWorker } from './queue.js';
import { jobOutbox } from './schema.js';

const logger = createLogger({ service: 'queue-int', level: 'silent' });
let pgC: Started<{ url: string }>;
let rc: Started<{ url: string }>;
let h: DbHandle;
let redis: Redis;

beforeAll(async () => {
  [pgC, rc] = await Promise.all([startPostgres(), startRedis()]);
  await createTables(pgC.value.url, { jobOutbox });
  h = createDb({ connectionString: pgC.value.url });
  redis = createRedis({ url: rc.value.url, role: 'queue', logger });
  await waitForReady(redis);
}, 180_000);

afterAll(async () => {
  redis?.disconnect();
  await h?.close();
  await Promise.all([pgC?.stop(), rc?.stop()]);
});

describe('job outbox → BullMQ', () => {
  it('dispatches committed jobs once, honours runAt and dedupes by jobId', async () => {
    const queue = createQueue('greet', redis);
    const seen: Array<{ id: string | undefined; at: number; data: unknown }> = [];
    const worker = createWorker<{ who: string }>({
      name: 'greet',
      connection: redis,
      logger,
      processor: async (job) => void seen.push({ id: job.id, at: Date.now(), data: job.data }),
    });
    const dispatcher = new JobOutboxDispatcher({
      db: h.db,
      logger,
      queues: { greet: queue },
      intervalMs: 50,
    });

    const t0 = Date.now();
    await withTransaction(h.db, async (tx) => {
      await addJobToOutbox(tx, { queue: 'greet', jobId: 'greet-a', name: 'greet', data: { who: 'a' } });
      await addJobToOutbox(tx, { queue: 'greet', jobId: 'greet-a', name: 'greet', data: { who: 'dup' } });
      await addJobToOutbox(tx, {
        queue: 'greet',
        jobId: 'greet-later',
        name: 'greet',
        data: { who: 'later' },
        runAt: new Date(Date.now() + 1500),
      });
    });
    await withTransaction(h.db, async (tx) => {
      await addJobToOutbox(tx, {
        queue: 'greet',
        jobId: 'greet-rolled-back',
        name: 'greet',
        data: { who: 'x' },
      });
      throw new Error('rollback');
    }).catch(() => undefined);

    dispatcher.start();
    await waitFor(async () => seen.length === 2, { timeoutMs: 20_000, what: 'two jobs processed' });
    await new Promise((r) => setTimeout(r, 500));

    expect(seen.map((s) => s.id).sort()).toEqual(['greet-a', 'greet-later']);
    expect(seen.find((s) => s.id === 'greet-a')!.data).toMatchObject({ who: 'a' });
    expect(seen.find((s) => s.id === 'greet-later')!.at - t0).toBeGreaterThanOrEqual(1400);

    // re-dispatching an already-dispatched job id is a no-op in BullMQ
    await queue.add('greet', { who: 'again' }, { jobId: 'greet-a' });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(2);

    await dispatcher.stop();
    await worker.close();
    await queue.close();
  }, 60_000);
});
