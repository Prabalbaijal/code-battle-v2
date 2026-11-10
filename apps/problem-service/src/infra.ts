import { createAuthHooks, createInternalAuth, JwtVerifier, type AuthHooks } from '@cb/auth';
import { TOPICS } from '@cb/contracts';
import { createDb, type DbHandle } from '@cb/db';
import { createKafka, createOutboxWriter, createProducer, OutboxRelay, type OutboxWriter } from '@cb/events';
import type { Logger } from '@cb/logger';
import type { FastifyRequest } from 'fastify';
import type { Kafka, Producer } from 'kafkajs';
import type { Env } from './config/env.js';
import { postgresBlobStore } from './lib/blobs.js';
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
  authHooks: AuthHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
  problems: ProblemService;
  close(): Promise<void>;
}

export async function createInfra(
  env: Env,
  logger: Logger,
  opts: { verifier?: JwtVerifier } = {},
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
  const verifier = opts.verifier ?? new JwtVerifier({ jwksUrl: env.JWKS_URL });
  const authHooks = createAuthHooks(verifier, { csrf: env.CSRF_REQUIRED });
  const internalAuth = createInternalAuth(env.INTERNAL_SERVICE_SECRET);
  const problems = new ProblemService({
    db: db.db,
    outbox,
    blobs: postgresBlobStore,
    selfUrl: env.SELF_URL,
    afterCommit: () => relay.kick(),
  });

  return {
    env,
    logger,
    db,
    kafka,
    producer,
    outbox,
    relay,
    authHooks,
    internalAuth,
    problems,
    async close() {
      await relay.stop();
      await producer.disconnect();
      await db.close();
    },
  };
}
