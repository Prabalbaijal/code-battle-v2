import { startLeaderLoop } from '@cb/db';
import { deadLetters, EventConsumer } from '@cb/events';
import { newId } from '@cb/ids';
import { createWorker } from '@cb/queue';
import { count } from 'drizzle-orm';
import { greetings } from './db/schema.js';
import { SERVICE_TOPICS, type Infra } from './infra.js';
import { greetingHandlers } from './modules/greeting/greeting.consumers.js';
import { greetingAckProcessor } from './modules/greeting/greeting.jobs.js';
import { QUEUES } from './queues.js';

export interface WorkerHandle {
  consumer: EventConsumer;
  stop(): Promise<void>;
}

/**
 * Background side of the service: Kafka consumers, BullMQ workers, outbox sweepers and a
 * leader-elected periodic task (the pattern battle-service's reconciler will use).
 */
export async function startWorker(
  infra: Infra,
  opts: { fromBeginning?: boolean } = {},
): Promise<WorkerHandle> {
  const consumer = new EventConsumer({
    kafka: infra.kafka,
    db: infra.db.db,
    logger: infra.logger,
    groupId: infra.env.SERVICE_NAME,
    topics: SERVICE_TOPICS,
    handlers: greetingHandlers(infra.greetings),
    fromBeginning: opts.fromBeginning ?? false,
  });
  await consumer.start();

  const worker = createWorker({
    name: QUEUES.greetingAck,
    connection: infra.redis,
    logger: infra.logger,
    processor: greetingAckProcessor(infra.greetings),
    onExhausted: async (job, err) => {
      await infra.db.db.insert(deadLetters).values({
        id: newId(),
        source: `bullmq:${QUEUES.greetingAck}`,
        payload: { jobId: job.id, data: job.data },
        error: String(err.stack ?? err),
        attempts: job.attemptsMade,
      });
    },
  });

  infra.relay.start();
  infra.dispatcher.start();

  const leader = startLeaderLoop({
    pool: infra.db.pool,
    name: `${infra.env.SERVICE_NAME}-stats`,
    intervalMs: 60_000,
    logger: infra.logger,
    task: async () => {
      const [row] = await infra.db.db.select({ n: count() }).from(greetings);
      infra.logger.info({ greetings: row?.n ?? 0 }, 'leader stats tick');
    },
  });

  return {
    consumer,
    async stop() {
      await leader.stop();
      await consumer.stop();
      await worker.close();
    },
  };
}
