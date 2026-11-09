import type { EventDefinition, EventEnvelope } from '@cb/contracts';
import type { Executor } from '@cb/db';
import { newId } from '@cb/ids';
import { currentTraceparent } from '@cb/telemetry';
import type { z } from 'zod';
import { outbox } from './schema.js';

export interface AddEventInput<D> {
  /** Kafka partition key — events with the same key stay ordered (e.g. matchId). */
  key: string;
  aggregateId?: string;
  data: D;
  /** User ids that should receive a realtime push for this event. */
  recipients?: string[];
}

export interface OutboxWriter {
  add<E extends EventDefinition<string, z.ZodType>>(
    tx: Executor,
    event: E,
    input: AddEventInput<z.input<E['schema']>>,
  ): Promise<EventEnvelope<z.output<E['schema']>>>;
}

/**
 * Writes events into the outbox table inside the caller's transaction (never publishes directly).
 * The relay publishes them after commit — no dual writes (plan §10.3, ADR-005).
 */
export function createOutboxWriter(source: string): OutboxWriter {
  return {
    async add<E extends EventDefinition<string, z.ZodType>>(
      tx: Executor,
      event: E,
      input: AddEventInput<z.input<E['schema']>>,
    ): Promise<EventEnvelope<z.output<E['schema']>>> {
      const data = event.schema.parse(input.data) as z.output<E['schema']>;
      const traceparent = currentTraceparent();
      const envelope: EventEnvelope<z.output<E['schema']>> = {
        id: newId(),
        type: event.type,
        source,
        occurredAt: new Date().toISOString(),
        aggregateId: input.aggregateId ?? input.key,
        ...(input.recipients ? { recipients: input.recipients } : {}),
        ...(traceparent ? { traceparent } : {}),
        data,
      };
      await tx.insert(outbox).values({
        id: envelope.id,
        topic: event.topic,
        key: input.key,
        type: event.type,
        payload: envelope,
      });
      return envelope;
    },
  };
}
