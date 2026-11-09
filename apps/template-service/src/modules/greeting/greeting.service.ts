import { templateEvents } from '@cb/contracts';
import { withTransaction, type Db, type Tx } from '@cb/db';
import { notFound } from '@cb/errors';
import type { OutboxWriter } from '@cb/events';
import { newId } from '@cb/ids';
import { addJobToOutbox } from '@cb/queue';
import type { Greeting } from '../../db/schema.js';
import { QUEUES } from '../../queues.js';
import { greetingRepository as repo } from './greeting.repository.js';

export interface GreetingServiceDeps {
  db: Db;
  outbox: OutboxWriter;
  /** Called after a commit that wrote outbox rows (kicks relay/dispatcher for low latency). */
  afterCommit?: () => void;
}

/** Use cases. Owns transaction boundaries; repositories only run SQL. */
export class GreetingService {
  constructor(private readonly d: GreetingServiceDeps) {}

  async create(authorId: string, message: string): Promise<Greeting> {
    const greeting = await withTransaction(this.d.db, async (tx) => {
      const g = await repo.insert(tx, { id: newId(), authorId, message });
      await this.d.outbox.add(tx, templateEvents.greetingCreatedV1, {
        key: g.id,
        data: { greetingId: g.id, authorId, message, createdAt: g.createdAt.toISOString() },
        recipients: [authorId],
      });
      await addJobToOutbox(tx, {
        queue: QUEUES.greetingAck,
        jobId: `greeting-ack-${g.id}`,
        name: 'ack',
        data: { greetingId: g.id },
      });
      return g;
    });
    this.d.afterCommit?.();
    return greeting;
  }

  async get(id: string): Promise<Greeting> {
    const g = await repo.findById(this.d.db, id);
    if (!g) throw notFound('Greeting');
    return g;
  }

  /** Kafka consumer effect — runs inside the consumer's inbox transaction. */
  async acknowledge(tx: Tx, greetingId: string): Promise<void> {
    await repo.markAcknowledged(tx, greetingId);
  }

  /** BullMQ job effect — idempotent via compare-and-set. */
  async processAckJob(greetingId: string): Promise<boolean> {
    return repo.markJobProcessed(this.d.db, greetingId);
  }
}
