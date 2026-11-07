import type { Logger } from '@cb/logger';
import { Kafka, Partitioners, logLevel, type Producer, type SASLOptions } from 'kafkajs';

export interface CreateKafkaOptions {
  clientId: string;
  brokers: string[];
  logger: Logger;
  ssl?: boolean;
  sasl?: { mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512'; username: string; password: string };
}

export function createKafka(opts: CreateKafkaOptions): Kafka {
  const log = opts.logger.child({ component: 'kafka' });
  return new Kafka({
    clientId: opts.clientId,
    brokers: opts.brokers,
    ssl: opts.ssl ?? false,
    ...(opts.sasl ? { sasl: opts.sasl as SASLOptions } : {}),
    logLevel: logLevel.WARN,
    retry: { retries: 8, initialRetryTime: 200 },
    logCreator:
      () =>
      ({ level, log: entry }) => {
        const { message, ...extra } = entry;
        if (level === logLevel.ERROR || level === logLevel.NOTHING) log.error(extra, message);
        else if (level === logLevel.WARN) log.warn(extra, message);
        else log.debug(extra, message);
      },
  });
}

/** Idempotent producer, acks=all — the outbox relay is its only user. */
export async function createProducer(kafka: Kafka): Promise<Producer> {
  const producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    createPartitioner: Partitioners.DefaultPartitioner,
  });
  await producer.connect();
  return producer;
}

/** Create topics if missing (dev/test; prod topics are created by infra). Default 2 partitions (plan §10.2). */
export async function ensureTopics(kafka: Kafka, topics: string[], numPartitions = 2): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = topics.filter((t) => !existing.has(t));
    if (missing.length) {
      await admin.createTopics({
        topics: missing.map((topic) => ({ topic, numPartitions })),
        waitForLeaders: true,
      });
    }
  } finally {
    await admin.disconnect();
  }
}
