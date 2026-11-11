import type { EmailJob } from '@cb/contracts';
import { deadLetters } from '@cb/events';
import type { HttpServer } from '@cb/http-server';
import { createLogger } from '@cb/logger';
import { createQueue, createWorker } from '@cb/queue';
import { startPostgres, startRedis, waitFor, type Started } from '@cb/testing';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { readEnv } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { emailLog, fakeInbox } from '../db/schema.js';
import { createInfra, type Infra } from '../infra.js';
import { emailSendProcessor } from '../modules/email/email.jobs.js';
import { EmailService } from '../modules/email/email.service.js';
import { EmailSendError, type EmailMessage, type EmailProvider } from '../modules/email/providers.js';
import { QUEUES } from '../queues.js';
import { startWorker, type WorkerHandle } from '../worker-runtime.js';

const logger = createLogger({ service: 'notification-int', level: 'silent' });
let pg: Started<{ url: string }>;
let redis: Started<{ url: string }>;
let infra: Infra;
let app: HttpServer;
let worker: WorkerHandle;
let queue: Queue;

/**
 * Wraps the fake inbox. Recipients starting with `flaky-N` fail N times (retryable) first,
 * `reject` fails permanently, `down` always fails (retryable).
 */
class ScriptedProvider implements EmailProvider {
  readonly name = 'scripted';
  readonly calls = new Map<string, number>();
  constructor(private readonly inner: EmailProvider) {}
  async send(m: EmailMessage) {
    const n = (this.calls.get(m.dedupeKey) ?? 0) + 1;
    this.calls.set(m.dedupeKey, n);
    const flaky = /^flaky-(\d+)/.exec(m.to);
    if (flaky && n <= Number(flaky[1])) throw new EmailSendError('provider 503', true, 503);
    if (m.to.startsWith('reject')) throw new EmailSendError('provider 400: invalid email', false, 400);
    if (m.to.startsWith('down')) throw new EmailSendError('provider 500', true, 500);
    return this.inner.send(m);
  }
}
let provider: ScriptedProvider;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  const env = readEnv({
    NODE_ENV: 'test',
    DATABASE_URL: pg.value.url,
    REDIS_URL: redis.value.url,
    EMAIL_RATE_PER_SEC: '50',
    // email only: no consumer starts, so Kafka is never contacted
    KAFKA_BROKERS: 'localhost:1',
    INTERNAL_SERVICE_SECRET: 'notification-test-internal-secret-0123456789',
  });
  await migrate(env.DATABASE_URL);
  infra = await createInfra(env, logger, {
    wrapProvider: (fake) => (provider = new ScriptedProvider(fake)),
  });
  app = await buildApp(infra);
  worker = await startWorker(infra, { inApp: false });
  // Producer side as identity configures it, but with fast backoff for tests.
  queue = createQueue(QUEUES.email, infra.queueRedis, { attempts: 4, backoff: { type: 'fixed', delay: 50 } });
});

afterAll(async () => {
  await worker?.stop();
  await queue?.close();
  await app?.close();
  await infra?.close();
  await Promise.all([pg?.stop(), redis?.stop()]);
});

const job = (to: string, template: EmailJob['template'] = 'verify_email'): EmailJob => ({
  template,
  to,
  vars: { name: 'Ann', link: `https://codebattle.test/verify-email?token=${randomUUID()}` },
  dedupeKey: `${template}:${randomUUID().slice(0, 12)}`,
});

const enqueue = (j: EmailJob, jobId = `email-${randomUUID()}`) => queue.add(j.template, j, { jobId });

const logRow = async (dedupeKey: string) =>
  (await infra.db.db.select().from(emailLog).where(eq(emailLog.dedupeKey, dedupeKey)))[0];

const inbox = async (to: string) =>
  (await app.inject({ method: 'GET', url: `/internal/dev/inbox?to=${encodeURIComponent(to)}` })).json() as {
    items: { subject: string; html: string; text: string; dedupeKey: string }[];
  };

describe('email-send worker', () => {
  it('delivers to the fake inbox and logs the send without storing the address', async () => {
    const j = job(`ann-${randomUUID().slice(0, 6)}@x.io`);
    await enqueue(j);
    const row = await waitFor(
      async () => (await logRow(j.dedupeKey))?.status === 'sent' && logRow(j.dedupeKey),
      {
        what: 'email sent',
      },
    );
    expect(row).toMatchObject({ attempts: 1, template: 'verify_email' });
    expect(JSON.stringify(row)).not.toContain(j.to);

    const { items } = await inbox(j.to.toUpperCase());
    expect(items).toHaveLength(1);
    expect(items[0]!.subject).toBe('Verify your Code Battle email');
    expect(items[0]!.text).toContain(j.vars.link);
  });

  it('dedupe: the same dedupeKey in several jobs (and concurrently) sends exactly once', async () => {
    const j = job(`dup-${randomUUID().slice(0, 6)}@x.io`);
    await Promise.all(Array.from({ length: 5 }, () => enqueue(j)));
    await waitFor(async () => (await logRow(j.dedupeKey))?.status === 'sent', { what: 'sent' });
    await waitFor(async () => (await queue.getJobCounts('active', 'waiting', 'delayed')).active === 0, {
      what: 'drained',
    });
    await new Promise((r) => setTimeout(r, 500));
    expect((await inbox(j.to)).items).toHaveLength(1);
  });

  it('retries transient provider errors and still sends once', async () => {
    const j = job(`flaky-2-${randomUUID().slice(0, 6)}@x.io`);
    await enqueue(j);
    const row = await waitFor(
      async () => (await logRow(j.dedupeKey))?.status === 'sent' && logRow(j.dedupeKey),
      {
        what: 'sent after retries',
      },
    );
    expect(row).toMatchObject({ attempts: 3 });
    expect(provider.calls.get(j.dedupeKey)).toBe(3);
    expect((await inbox(j.to)).items).toHaveLength(1);
  });

  it('does not retry permanent rejections', async () => {
    const j = job(`reject-${randomUUID().slice(0, 6)}@x.io`);
    await enqueue(j);
    const row = await waitFor(
      async () => (await logRow(j.dedupeKey))?.status === 'failed' && logRow(j.dedupeKey),
      {
        what: 'failed',
      },
    );
    expect(row).toMatchObject({ attempts: 1, lastError: 'provider 400: invalid email' });
    await new Promise((r) => setTimeout(r, 300));
    expect(provider.calls.get(j.dedupeKey)).toBe(1);
  });

  it('after exhausting retries: marks failed and writes a dead letter without the link', async () => {
    const j = job(`down-${randomUUID().slice(0, 6)}@x.io`);
    const added = await enqueue(j);
    await waitFor(async () => (await logRow(j.dedupeKey))?.status === 'failed', {
      what: 'exhausted',
      timeoutMs: 20_000,
    });
    expect(provider.calls.get(j.dedupeKey)).toBe(4);
    const dl = await waitFor(
      async () =>
        (await infra.db.db.select().from(deadLetters)).find(
          (d) => (d.payload as { jobId?: string }).jobId === added.id,
        ),
      { what: 'dead letter' },
    );
    expect(JSON.stringify(dl.payload)).not.toContain('token=');
  });

  it('rejects malformed payloads without retrying', async () => {
    const bad = await queue.add(
      'verify_email',
      { template: 'verify_email', to: 'not-an-email' },
      { jobId: `email-bad-${randomUUID()}` },
    );
    await waitFor(async () => (await bad.getState()) === 'failed', { what: 'failed' });
    expect((await queue.getJob(bad.id!))!.attemptsMade).toBe(1);
  });

  it('defers to the next UTC midnight when the daily cap is reached', async () => {
    const capped = new EmailService({ db: infra.db.db, provider, logger, dailyCap: 1 }); // ≥1 already sent above
    const capQueue = createQueue(`${QUEUES.email}-cap-test`, infra.queueRedis);
    const capWorker = createWorker({
      name: `${QUEUES.email}-cap-test`,
      connection: infra.queueRedis,
      logger,
      processor: emailSendProcessor(capped),
    });
    try {
      const j = job(`capped-${randomUUID().slice(0, 6)}@x.io`);
      const added = await capQueue.add('verify_email', j, { jobId: `cap-${randomUUID()}` });
      await waitFor(async () => (await added.getState()) === 'delayed', { what: 'delayed' });
      const delayedJob = (await capQueue.getJob(added.id!))!;
      const runAt = delayedJob.timestamp + delayedJob.delay;
      const midnight = new Date();
      midnight.setUTCHours(24, 0, 0, 0);
      expect(runAt).toBeGreaterThanOrEqual(midnight.getTime());
      expect(runAt).toBeLessThan(midnight.getTime() + 61_000);
      expect(await logRow(j.dedupeKey)).toBeUndefined(); // nothing claimed or sent
      expect(provider.calls.has(j.dedupeKey)).toBe(false);
    } finally {
      await capWorker.close();
      await capQueue.obliterate({ force: true });
      await capQueue.close();
    }
  });

  it('exposes the dev inbox only with the fake provider', async () => {
    expect((await app.inject({ method: 'GET', url: '/internal/dev/inbox?to=bad' })).statusCode).toBe(400);
    expect((await infra.db.db.select().from(fakeInbox)).length).toBeGreaterThan(0);
  });
});
