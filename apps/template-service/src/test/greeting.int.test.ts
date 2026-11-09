import { ensureTopics, outbox } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { createLogger } from '@cb/logger';
import { startPostgres, startRedis, startRedpanda, waitFor, type Started } from '@cb/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { readEnv } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createInfra, SERVICE_TOPICS, type Infra } from '../infra.js';
import type { GreetingDto } from '../modules/greeting/greeting.schemas.js';
import { startWorker, type WorkerHandle } from '../worker-runtime.js';

const logger = createLogger({ service: 'template-int', level: 'silent' });
let pg: Started<{ url: string }>;
let redis: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let infra: Infra;
let app: HttpServer;
let worker: WorkerHandle;

beforeAll(async () => {
  [pg, redis, rp] = await Promise.all([startPostgres(), startRedis(), startRedpanda()]);
  const env = readEnv({
    SERVICE_NAME: 'template-service',
    DATABASE_URL: pg.value.url,
    REDIS_URL: redis.value.url,
    KAFKA_BROKERS: rp.value.brokers.join(','),
  });
  await migrate(env.DATABASE_URL);
  infra = await createInfra(env, logger);
  await ensureTopics(infra.kafka, SERVICE_TOPICS);
  app = await buildApp(infra);
  worker = await startWorker(infra, { fromBeginning: true });
});

afterAll(async () => {
  await worker?.stop();
  await app?.close();
  await infra?.close();
  await Promise.all([pg?.stop(), redis?.stop(), rp?.stop()]);
});

const post = (body: unknown, key?: string, user = 'u1') =>
  app.inject({
    method: 'POST',
    url: '/api/v1/greetings',
    payload: body as object,
    headers: { 'x-user-id': user, ...(key ? { 'idempotency-key': key } : {}) },
  });

describe('template-service end to end', () => {
  it('is ready when db and redis are up', async () => {
    const r = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r.json()).toEqual({ status: 'ok', checks: { db: 'ok', redis: 'ok' } });
  });

  it('creates a greeting; the event and the job are each applied exactly once', async () => {
    const res = await post({ message: 'hello' }, randomUUID());
    expect(res.statusCode).toBe(201);
    const created = res.json() as GreetingDto;

    const done = await waitFor(
      async () => {
        const g = (
          await app.inject({ method: 'GET', url: `/api/v1/greetings/${created.id}` })
        ).json() as GreetingDto;
        return g.acknowledgedAt && g.jobProcessedAt ? g : undefined;
      },
      { timeoutMs: 60_000, what: 'consumer + job effects' },
    );
    expect(done.ackCount).toBe(1);

    // Kafka redelivery of the same envelope is a no-op thanks to the inbox.
    const [row] = await infra.db.db.select().from(outbox);
    expect(await worker.consumer.process(JSON.stringify(row!.payload))).toBe('duplicate');
    // Re-running the job is a no-op thanks to compare-and-set.
    expect(await infra.greetings.processAckJob(created.id)).toBe(false);
    const after = (await app.inject({ method: 'GET', url: `/api/v1/greetings/${created.id}` })).json();
    expect(after.ackCount).toBe(1);
  });

  it('enforces Idempotency-Key semantics', async () => {
    expect((await post({ message: 'x' })).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = randomUUID();
    const first = await post({ message: 'once' }, key);
    const replay = await post({ message: 'once' }, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().id).toBe(first.json().id);

    const reused = await post({ message: 'different' }, key);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // keys are scoped per user
    const other = await post({ message: 'once' }, key, 'u2');
    expect(other.statusCode).toBe(201);
    expect(other.json().id).not.toBe(first.json().id);
  });

  it('handles concurrent duplicate submissions: one creates, others replay or wait', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => post({ message: 'race' }, key)));
    const created = results.filter((r) => r.statusCode === 201);
    const ids = new Set(created.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
  });

  it('validates input and returns 404 for unknown ids', async () => {
    const bad = await post({ message: '' }, randomUUID());
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: `/api/v1/greetings/${randomUUID()}` });
    expect(missing.statusCode).toBe(404);
  });
});
