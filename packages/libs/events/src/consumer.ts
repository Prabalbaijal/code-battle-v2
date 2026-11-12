import { counter, gauge } from '@cb/metrics';
import { envelopeBaseSchema, type EventDefinition, type EventEnvelope } from '@cb/contracts';
import { withTransaction, type Db, type Tx } from '@cb/db';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { withSpan } from '@cb/telemetry';
import type { Consumer, Kafka } from 'kafkajs';
import type { z } from 'zod';
import { deadLetters, processedEvents } from './schema.js';

/** Type-erased handler stored by the consumer. Create with `on(event, handler)`. */
export interface EventHandler {
  type: string;
  schema: z.ZodType;
  handle(tx: Tx, envelope: EventEnvelope<unknown>): Promise<void>;
}

/** Bind a typed handler to an event definition. */
export function on<E extends EventDefinition<string, z.ZodType>>(
  event: E,
  handle: (tx: Tx, envelope: EventEnvelope<z.output<E['schema']>>) => Promise<void>,
): EventHandler {
  return { type: event.type, schema: event.schema, handle: handle as EventHandler['handle'] };
}

export interface EventConsumerOptions {
  kafka: Kafka;
  db: Db;
  logger: Logger;
  groupId: string;
  topics: string[];
  handlers: EventHandler[];
  /** Name in processed_events; defaults to groupId. */
  consumerName?: string;
  maxAttempts?: number;
  fromBeginning?: boolean;
  /** Backoff between in-process retries (overridable in tests). */
  retryDelayMs?: (attempt: number) => number;
}

export type ProcessResult = 'processed' | 'duplicate' | 'skipped' | 'dead_lettered';

/**
 * At-least-once delivery + inbox dedupe ⇒ exactly-once effect (plan §10.3).
 * The inbox row and the handler's writes commit in one transaction; the offset is committed after.
 * Poison messages go to dead_letters after `maxAttempts` so they never block the partition.
 */
/** Plan §19: `kafka_consumer_lag{group}` and what the consumers did with each event. */
const consumerLag = gauge('kafka_consumer_lag', 'Messages behind the latest offset', [
  'group',
  'topic',
  'partition',
]);
const consumed = counter('events_consumed_total', 'Events handled by consumers', ['group', 'result']);

export class EventConsumer {
  private consumer: Consumer | undefined;
  private readonly handlers = new Map<string, EventHandler>();
  private readonly name: string;
  private readonly maxAttempts: number;

  constructor(private readonly o: EventConsumerOptions) {
    for (const h of o.handlers) this.handlers.set(h.type, h);
    this.name = o.consumerName ?? o.groupId;
    this.maxAttempts = o.maxAttempts ?? 5;
  }

  async start(): Promise<void> {
    this.consumer = this.o.kafka.consumer({ groupId: this.o.groupId });
    await this.consumer.connect();
    for (const topic of this.o.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: this.o.fromBeginning ?? false });
    }
    const group = this.o.groupId;
    this.consumer.on(this.consumer.events.END_BATCH_PROCESS, ({ payload }) => {
      consumerLag.set(
        { group, topic: payload.topic, partition: String(payload.partition) },
        Number(payload.offsetLag),
      );
    });
    await this.consumer.run({
      partitionsConsumedConcurrently: 1,
      eachMessage: async ({ message }) => {
        const result = await this.process(message.value?.toString('utf8') ?? '');
        consumed.inc({ group, result });
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer?.disconnect();
  }

  /** Process one raw message. Public so tests can drive it without Kafka. */
  async process(raw: string): Promise<ProcessResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.deadLetter({ raw }, 'invalid JSON', 1);
      return 'dead_lettered';
    }
    const base = envelopeBaseSchema.safeParse(parsed);
    if (!base.success) {
      await this.deadLetter(parsed, `invalid envelope: ${base.error.message}`, 1);
      return 'dead_lettered';
    }
    const env = base.data;
    const handler = this.handlers.get(env.type);
    if (!handler) return 'skipped';

    const data = handler.schema.safeParse(env.data);
    if (!data.success) {
      await this.deadLetter(env, `invalid data for ${env.type}: ${data.error.message}`, 1);
      return 'dead_lettered';
    }
    const envelope: EventEnvelope<unknown> = { ...env, data: data.data };

    for (let attempt = 1; ; attempt++) {
      try {
        return await withSpan(
          `consume ${env.type}`,
          () =>
            withTransaction(this.o.db, async (tx) => {
              const inserted = await tx
                .insert(processedEvents)
                .values({ consumer: this.name, eventId: env.id })
                .onConflictDoNothing()
                .returning({ id: processedEvents.eventId });
              if (inserted.length === 0) return 'duplicate' as const;
              await handler.handle(tx, envelope);
              return 'processed' as const;
            }),
          { traceparent: env.traceparent },
          { 'messaging.consumer': this.name, 'event.id': env.id },
        );
      } catch (err) {
        if (attempt >= this.maxAttempts) {
          this.o.logger.error({ err, eventId: env.id, type: env.type }, 'event handler failed permanently');
          await this.deadLetter(env, String((err as Error)?.stack ?? err), attempt);
          return 'dead_lettered';
        }
        const delay = this.o.retryDelayMs?.(attempt) ?? Math.min(100 * 2 ** attempt, 5000);
        this.o.logger.warn({ err, eventId: env.id, attempt }, 'event handler failed; retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** If even this insert fails (DB down) we throw, so the offset is not committed and Kafka redelivers. */
  private async deadLetter(payload: unknown, error: string, attempts: number) {
    await this.o.db.insert(deadLetters).values({
      id: newId(),
      source: `kafka:${this.name}`,
      payload: payload as object,
      error: error.slice(0, 8000),
      attempts,
    });
  }
}
