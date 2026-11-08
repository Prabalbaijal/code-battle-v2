import { TOPICS } from '@cb/contracts';
import { createDb, type DbHandle } from '@cb/db';
import { createKafka, createOutboxWriter, createProducer, OutboxRelay, type OutboxWriter } from '@cb/events';
import type { Logger } from '@cb/logger';
import { createQueue, JobOutboxDispatcher } from '@cb/queue';
import { createRedis, SafeRedis, type Redis } from '@cb/redis';
import type { Queue } from 'bullmq';
import type { Kafka, Producer } from 'kafkajs';
import type { Env } from './config/env.js';
import { GreetingService } from './modules/greeting/greeting.service.js';
import { QUEUES } from './queues.js';

/** Topics this service publishes to / consumes from. */
export const SERVICE_TOPICS = [TOPICS.template];

/** Everything both the API and the worker process need. Composition root lives here. */
export interface Infra {
  env: Env;
  logger: Logger;
  db: DbHandle;
  redis: Redis;
  safeRedis: SafeRedis;
  kafka: Kafka;
  producer: Producer;
  queues: Record<string, Queue>;
  outbox: OutboxWriter;
  relay: OutboxRelay;
  dispatcher: JobOutboxDispatcher;
  greetings: GreetingService;
  close(): Promise<void>;
}

export async function createInfra(env: Env, logger: Logger): Promise<Infra> {
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: env.SERVICE_NAME, logger });
  const redis = createRedis({ url: env.REDIS_URL, role: 'queue', logger, name: env.SERVICE_NAME });
  const safeRedis = new SafeRedis(redis, logger);
  const kafka = createKafka({
    clientId: env.SERVICE_NAME,
    brokers: env.KAFKA_BROKERS,
    logger,
    ssl: env.KAFKA_SSL,
    ...(env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD
      ? {
          sasl: {
            mechanism: 'scram-sha-256',
            username: env.KAFKA_SASL_USERNAME,
            password: env.KAFKA_SASL_PASSWORD,
          },
        }
      : {}),
  });
  const producer = await createProducer(kafka);
  const queues: Record<string, Queue> = { [QUEUES.greetingAck]: createQueue(QUEUES.greetingAck, redis) };
  const outbox = createOutboxWriter(env.SERVICE_NAME);
  const relay = new OutboxRelay({ db: db.db, producer, logger });
  const dispatcher = new JobOutboxDispatcher({ db: db.db, logger, queues });
  const greetings = new GreetingService({
    db: db.db,
    outbox,
    afterCommit: () => {
      relay.kick();
      dispatcher.kick();
    },
  });

  return {
    env,
    logger,
    db,
    redis,
    safeRedis,
    kafka,
    producer,
    queues,
    outbox,
    relay,
    dispatcher,
    greetings,
    async close() {
      await relay.stop();
      await dispatcher.stop();
      await Promise.all(Object.values(queues).map((q) => q.close()));
      await producer.disconnect();
      redis.disconnect();
      await db.close();
    },
  };
}
