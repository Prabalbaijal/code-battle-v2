import { createAuthHooks, createInternalAuth, JwtVerifier, type AuthHooks } from '@cb/auth';
import { TOPICS } from '@cb/contracts';
import { createDb, type DbHandle } from '@cb/db';
import { createKafka, createOutboxWriter, createProducer, OutboxRelay, type OutboxWriter } from '@cb/events';
import type { Logger } from '@cb/logger';
import { createQueue, JobOutboxDispatcher } from '@cb/queue';
import { createRedis, SafeRedis, type Redis } from '@cb/redis';
import type { Queue } from 'bullmq';
import type { FastifyRequest } from 'fastify';
import type { Kafka, Producer } from 'kafkajs';
import type { Env } from './config/env.js';
import { postgresBlobStore } from './lib/blobs.js';
import { CALIBRATE_QUEUE, CalibrationService } from './modules/calibration/calibration.service.js';
import { HttpJudgeClient, type JudgeClient } from './modules/calibration/judge-client.js';
import { ProblemService } from './modules/problems/problems.service.js';

/** Publishes problem events. (Consumes battle events from Phase 3.) */
export const SERVICE_TOPICS = [TOPICS.problem];

export interface Infra {
  env: Env;
  logger: Logger;
  db: DbHandle;
  kafka: Kafka;
  producer: Producer;
  outbox: OutboxWriter;
  relay: OutboxRelay;
  queueRedis: Redis;
  safeRedis: SafeRedis;
  queues: Record<string, Queue>;
  dispatcher: JobOutboxDispatcher;
  authHooks: AuthHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
  problems: ProblemService;
  calibration: CalibrationService;
  close(): Promise<void>;
}

export async function createInfra(
  env: Env,
  logger: Logger,
  opts: { verifier?: JwtVerifier; judge?: JudgeClient; calibrationPollMs?: number } = {},
): Promise<Infra> {
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: env.SERVICE_NAME, logger });
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
  const producer = createProducer(kafka);
  const outbox = createOutboxWriter(env.SERVICE_NAME);
  const relay = new OutboxRelay({ db: db.db, producer, logger });
  const queueRedis = createRedis({ url: env.REDIS_URL, role: 'queue', logger, name: env.SERVICE_NAME });
  const safeRedis = new SafeRedis(queueRedis, logger);
  const queues: Record<string, Queue> = {
    // one attempt is plenty: the job waits on the judge itself, and a rerun is one click away
    [CALIBRATE_QUEUE]: createQueue(CALIBRATE_QUEUE, queueRedis, { attempts: 2 }),
  };
  const dispatcher = new JobOutboxDispatcher({ db: db.db, logger, queues });
  const verifier = opts.verifier ?? new JwtVerifier({ jwksUrl: env.JWKS_URL });
  const authHooks = createAuthHooks(verifier, { csrf: env.CSRF_REQUIRED });
  const internalAuth = createInternalAuth(env.INTERNAL_SERVICE_SECRET);
  const problems = new ProblemService({
    db: db.db,
    outbox,
    blobs: postgresBlobStore,
    selfUrl: env.SELF_URL,
    afterCommit: () => {
      relay.kick();
      dispatcher.kick();
    },
  });
  const calibration = new CalibrationService({
    db: db.db,
    problems,
    blobs: postgresBlobStore,
    judge:
      opts.judge ??
      new HttpJudgeClient({
        baseUrl: env.JUDGE_SERVICE_URL,
        secret: env.INTERNAL_SERVICE_SECRET,
        service: env.SERVICE_NAME,
      }),
    logger,
    ...(opts.calibrationPollMs ? { pollIntervalMs: opts.calibrationPollMs } : {}),
    afterCommit: () => dispatcher.kick(),
  });

  return {
    env,
    logger,
    db,
    kafka,
    producer,
    outbox,
    relay,
    queueRedis,
    safeRedis,
    queues,
    dispatcher,
    authHooks,
    internalAuth,
    problems,
    calibration,
    async close() {
      await relay.stop();
      await dispatcher.stop();
      await Promise.all(Object.values(queues).map((q) => q.close()));
      queueRedis.disconnect();
      await producer.disconnect();
      await db.close();
    },
  };
}
