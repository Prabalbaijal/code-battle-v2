import {
  createAuthHooks,
  generateSigningKey,
  JwtVerifier,
  parseSigningKeys,
  TokenSigner,
  type AuthHooks,
} from '@cb/auth';
import { TOPICS } from '@cb/contracts';
import { createDb, type DbHandle } from '@cb/db';
import { createKafka, createOutboxWriter, createProducer, OutboxRelay, type OutboxWriter } from '@cb/events';
import type { Logger } from '@cb/logger';
import { createQueue, JobOutboxDispatcher } from '@cb/queue';
import { createRedis, SafeRedis, type Redis } from '@cb/redis';
import type { Queue } from 'bullmq';
import type { Kafka, Producer } from 'kafkajs';
import type { Env } from './config/env.js';
import { createAuthRateLimits, type AuthRateLimits } from './modules/auth/auth.rate-limits.js';
import { AuthService } from './modules/auth/auth.service.js';
import { QUEUES } from './queues.js';

/** Topics this service publishes to. It consumes none. */
export const SERVICE_TOPICS = [TOPICS.user];

/** Everything both the API and the worker process need. Composition root lives here. */
export interface Infra {
  env: Env;
  logger: Logger;
  db: DbHandle;
  /** BullMQ connection (blocking commands, infinite retries). */
  queueRedis: Redis;
  /** Fail-fast client for rate limits; callers fall back to memory when it's down. */
  safeRedis: SafeRedis;
  kafka: Kafka;
  producer: Producer;
  queues: Record<string, Queue>;
  outbox: OutboxWriter;
  relay: OutboxRelay;
  dispatcher: JobOutboxDispatcher;
  signer: TokenSigner;
  verifier: JwtVerifier;
  authHooks: AuthHooks;
  limits: AuthRateLimits;
  auth: AuthService;
  close(): Promise<void>;
}

async function loadSigner(env: Env, logger: Logger): Promise<TokenSigner> {
  if (env.JWT_KEYS) return TokenSigner.create(parseSigningKeys(env.JWT_KEYS));
  // Dev/test only (env validation requires JWT_KEYS in production).
  logger.warn('JWT_KEYS not set: using an ephemeral signing key; sessions end when the process restarts');
  return TokenSigner.create([await generateSigningKey('dev-ephemeral')]);
}

export async function createInfra(env: Env, logger: Logger): Promise<Infra> {
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: env.SERVICE_NAME, logger });
  const queueRedis = createRedis({ url: env.REDIS_URL, role: 'queue', logger, name: env.SERVICE_NAME });
  const cacheRedis = createRedis({ url: env.REDIS_URL, role: 'cache', logger, name: env.SERVICE_NAME });
  const safeRedis = new SafeRedis(cacheRedis, logger);
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
  const queues: Record<string, Queue> = { [QUEUES.email]: createQueue(QUEUES.email, queueRedis) };
  const outbox = createOutboxWriter(env.SERVICE_NAME);
  const relay = new OutboxRelay({ db: db.db, producer, logger });
  const dispatcher = new JobOutboxDispatcher({ db: db.db, logger, queues });

  const signer = await loadSigner(env, logger);
  // identity verifies its own tokens locally (no JWKS round trip to itself)
  const verifier = new JwtVerifier({ jwks: signer.publicJwks() });
  const authHooks = createAuthHooks(verifier, { csrf: env.CSRF_REQUIRED });
  const limits = createAuthRateLimits(safeRedis, logger);
  const auth = new AuthService({
    db: db.db,
    outbox,
    signer,
    logger,
    config: {
      accessTtlSec: env.ACCESS_TOKEN_TTL_SEC,
      refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      webBaseUrl: env.WEB_BASE_URL,
      realtimeUrl: env.REALTIME_URL,
    },
    afterCommit: () => {
      relay.kick();
      dispatcher.kick();
    },
  });

  return {
    env,
    logger,
    db,
    queueRedis,
    safeRedis,
    kafka,
    producer,
    queues,
    outbox,
    relay,
    dispatcher,
    signer,
    verifier,
    authHooks,
    limits,
    auth,
    async close() {
      await relay.stop();
      await dispatcher.stop();
      await Promise.all(Object.values(queues).map((q) => q.close()));
      await producer.disconnect();
      queueRedis.disconnect();
      cacheRedis.disconnect();
      await db.close();
    },
  };
}
