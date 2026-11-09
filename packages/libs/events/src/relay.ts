import { withTransaction, type Db } from '@cb/db';
import type { Logger } from '@cb/logger';
import { runUntraced } from '@cb/telemetry';
import { asc, inArray, isNull } from 'drizzle-orm';
import type { Producer } from 'kafkajs';
import { outbox } from './schema.js';

export interface OutboxRelayOptions {
  db: Db;
  producer: Producer;
  logger: Logger;
  batchSize?: number;
  /** Sweep interval; `kick()` triggers an immediate run after a commit. */
  intervalMs?: number;
}

/**
 * Publishes committed outbox rows to Kafka.
 * `FOR UPDATE SKIP LOCKED` lets several relay instances run without double-sending the same batch;
 * if Kafka accepts but the UPDATE fails, rows are re-sent ⇒ at-least-once (consumers dedupe by id).
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private pendingKick = false;
  private connecting: Promise<void> | undefined;
  private readonly batchSize: number;
  private readonly intervalMs: number;

  constructor(private readonly o: OutboxRelayOptions) {
    this.batchSize = o.batchSize ?? 100;
    this.intervalMs = o.intervalMs ?? 1000;
    o.producer.on(o.producer.events.DISCONNECT, () => {
      this.connecting = undefined;
    });
  }

  /** Connect on first use; a failed attempt is retried on the next tick. */
  private ensureConnected(): Promise<void> {
    this.connecting ??= this.o.producer.connect().catch((err: unknown) => {
      this.connecting = undefined;
      throw err;
    });
    return this.connecting;
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Ask for an immediate publish (call after committing a tx that wrote outbox rows). */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.pendingKick = true;
      return;
    }
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running?.catch(() => {});
  }

  /** Publish one batch; returns the number of events sent. */
  async publishBatch(): Promise<number> {
    await this.ensureConnected();
    return withTransaction(this.o.db, async (tx) => {
      const rows = await tx
        .select()
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        .orderBy(asc(outbox.createdAt), asc(outbox.id))
        .limit(this.batchSize)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return 0;

      const byTopic = new Map<string, typeof rows>();
      for (const r of rows) byTopic.set(r.topic, [...(byTopic.get(r.topic) ?? []), r]);

      await this.o.producer.sendBatch({
        acks: -1,
        topicMessages: [...byTopic].map(([topic, msgs]) => ({
          topic,
          messages: msgs.map((r) => {
            const traceparent = (r.payload as { traceparent?: string }).traceparent;
            return {
              key: r.key,
              value: JSON.stringify(r.payload),
              headers: { 'event-id': r.id, 'event-type': r.type, ...(traceparent ? { traceparent } : {}) },
            };
          }),
        })),
      });
      await tx
        .update(outbox)
        .set({ publishedAt: new Date() })
        .where(
          inArray(
            outbox.id,
            rows.map((r) => r.id),
          ),
        );
      return rows.length;
    });
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    // Detached from any request trace; consumers still link to the producer via `traceparent`.
    this.timer = runUntraced(() =>
      setTimeout(() => {
        this.running = this.drain().finally(() => {
          this.running = undefined;
          if (this.stopped) return;
          const again = this.pendingKick;
          this.pendingKick = false;
          this.schedule(again ? 0 : this.intervalMs);
        });
      }, delay),
    );
  }

  private async drain() {
    try {
      while (!this.stopped && (await this.publishBatch()) === this.batchSize) {
        /* keep draining full batches */
      }
    } catch (err) {
      this.o.logger.warn({ err }, 'outbox relay failed; will retry');
    }
  }
}
