import { TOPICS, defineEvent } from '@cb/contracts';
import { createDb, withTransaction, type DbHandle } from '@cb/db';
import { createLogger } from '@cb/logger';
import { createTables, startPostgres, startRedpanda, waitFor, type Started } from '@cb/testing';
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import type { Kafka, Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventConsumer, on } from './consumer.js';
import { createKafka, createProducer, ensureTopics } from './kafka.js';
import { createOutboxWriter } from './outbox.js';
import { OutboxRelay } from './relay.js';
import { deadLetters, outbox, processedEvents } from './schema.js';

const counters = pgTable('counters', { id: text('id').primaryKey(), n: integer('n').notNull().default(0) });
const pinged = defineEvent(
  TOPICS.template,
  'template.counter.pinged.v1',
  z.object({ counterId: z.string() }),
);
const logger = createLogger({ service: 'events-int', level: 'silent' });

let pgC: Started<{ url: string }>;
let rp: Started<{ brokers: string[] }>;
let h: DbHandle;
let kafka: Kafka;
let producer: Producer;

beforeAll(async () => {
  [pgC, rp] = await Promise.all([startPostgres(), startRedpanda()]);
  await createTables(pgC.value.url, { outbox, processedEvents, deadLetters, counters });
  h = createDb({ connectionString: pgC.value.url });
  kafka = createKafka({ clientId: 'events-int', brokers: rp.value.brokers, logger });
  await ensureTopics(kafka, [TOPICS.template]);
  producer = createProducer(kafka);
}, 180_000);

afterAll(async () => {
  await producer?.disconnect();
  await h?.close();
  await Promise.all([pgC?.stop(), rp?.stop()]);
});

describe('outbox → kafka → consumer (inbox)', () => {
  it('delivers committed events exactly-once in effect, even when redelivered', async () => {
    const writer = createOutboxWriter('events-int');
    await h.db.insert(counters).values({ id: 'c1' });

    let first: Awaited<ReturnType<typeof writer.add>> | undefined;
    await withTransaction(h.db, async (tx) => {
      first = await writer.add(tx, pinged, { key: 'c1', data: { counterId: 'c1' } });
    });
    // a rolled-back transaction must not leave an event behind
    await withTransaction(h.db, async (tx) => {
      await writer.add(tx, pinged, { key: 'c1', data: { counterId: 'c1' } });
      throw new Error('rollback');
    }).catch(() => undefined);

    const relay = new OutboxRelay({ db: h.db, producer, logger, intervalMs: 100 });
    const consumer = new EventConsumer({
      kafka,
      db: h.db,
      logger,
      groupId: 'events-int-group',
      topics: [TOPICS.template],
      fromBeginning: true,
      handlers: [
        on(pinged, async (tx, env) => {
          await tx
            .update(counters)
            .set({ n: sql`${counters.n} + 1` })
            .where(eq(counters.id, env.data.counterId));
        }),
      ],
    });
    await consumer.start();
    relay.start();

    await waitFor(async () => (await h.db.select().from(counters).where(eq(counters.id, 'c1')))[0]?.n === 1, {
      timeoutMs: 60_000,
      what: 'counter incremented',
    });
    const published = await h.db.select().from(outbox);
    expect(published).toHaveLength(1);
    expect(published[0]!.publishedAt).not.toBeNull();

    // simulate Kafka redelivery of the same envelope ⇒ inbox makes it a no-op
    expect(await consumer.process(JSON.stringify(first))).toBe('duplicate');
    expect((await h.db.select().from(counters))[0]!.n).toBe(1);

    await relay.stop();
    await consumer.stop();
  }, 120_000);

  it('dead-letters poison messages and keeps going', async () => {
    let calls = 0;
    const consumer = new EventConsumer({
      kafka,
      db: h.db,
      logger,
      groupId: 'unused',
      topics: [],
      maxAttempts: 3,
      retryDelayMs: () => 1,
      handlers: [
        on(pinged, async () => {
          calls++;
          throw new Error('handler bug');
        }),
      ],
    });
    const env = {
      id: '0190f5b2-6c1e-7cc2-9a59-3b0f6f3c2a99',
      type: pinged.type,
      source: 't',
      occurredAt: new Date().toISOString(),
      aggregateId: 'x',
      data: { counterId: 'x' },
    };
    expect(await consumer.process(JSON.stringify(env))).toBe('dead_lettered');
    expect(calls).toBe(3);
    expect(await consumer.process('not json')).toBe('dead_lettered');
    expect(await consumer.process(JSON.stringify({ ...env, data: { wrong: 1 } }))).toBe('dead_lettered');
    expect(await consumer.process(JSON.stringify({ ...env, type: 'other.thing.done.v1' }))).toBe('skipped');
    const dls = await h.db.select().from(deadLetters);
    expect(dls).toHaveLength(3);
    // failed handler attempts must not leave an inbox row behind
    expect(await h.db.select().from(processedEvents).where(eq(processedEvents.eventId, env.id))).toHaveLength(
      0,
    );
  });
});
