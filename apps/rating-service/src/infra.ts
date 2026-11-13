import { createAuthHooks, createInternalAuth, JwtVerifier, type AuthHooks } from '@cb/auth';
import { TOPICS } from '@cb/contracts';
import { createDb, type DbHandle } from '@cb/db';
import { createKafka, createOutboxWriter, createProducer, OutboxRelay, type OutboxWriter } from '@cb/events';
import type { Logger } from '@cb/logger';
import { createRedis, SafeRedis, type Redis } from '@cb/redis';
import type { FastifyRequest } from 'fastify';
import type { Kafka, Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { HttpUserDirectory, type UserDirectory } from './clients.js';
import type { Env } from './config/env.js';
import { LeaderboardService } from './modules/leaderboard.service.js';
import { StatsService } from './modules/stats.service.js';

/**
 * rating-service consumes registrations/role changes (user), finished matches (battle), and its
 * own stats events (rating), which move the leaderboard ZSET after the change has committed.
 */
export const SERVICE_TOPICS = [TOPICS.user, TOPICS.battle, TOPICS.rating];

export interface Infra {
  env: Env;
  logger: Logger;
  db: DbHandle;
  redis: Redis;
  safeRedis: SafeRedis;
  kafka: Kafka;
  producer: Producer;
  outbox: OutboxWriter;
  relay: OutboxRelay;
  authHooks: AuthHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
  stats: StatsService;
  leaderboard: LeaderboardService;
  close(): Promise<void>;
}

export interface InfraOptions {
  verifier?: JwtVerifier;
  users?: UserDirectory;
}

export async function createInfra(env: Env, logger: Logger, opts: InfraOptions = {}): Promise<Infra> {
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: env.SERVICE_NAME, logger });
  // the leaderboard is a read index with a Postgres fallback: fail fast, never queue commands
  const redis = createRedis({ url: env.REDIS_URL, role: 'cache', logger, name: env.SERVICE_NAME });
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
  const producer = createProducer(kafka);
  const outbox = createOutboxWriter(env.SERVICE_NAME);
  const relay = new OutboxRelay({ db: db.db, producer, logger });
  const users =
    opts.users ??
    new HttpUserDirectory({
      baseUrl: env.USER_SERVICE_URL,
      secret: env.INTERNAL_SERVICE_SECRET,
      service: env.SERVICE_NAME,
    });
  const stats = new StatsService({ db: db.db, outbox, logger });
  const leaderboard = new LeaderboardService({
    db: db.db,
    redis: safeRedis,
    users,
    stats,
    logger,
    nodeId: randomUUID().slice(0, 8),
  });

  const verifier = opts.verifier ?? new JwtVerifier({ jwksUrl: env.JWKS_URL });
  return {
    env,
    logger,
    db,
    redis,
    safeRedis,
    kafka,
    producer,
    outbox,
    relay,
    authHooks: createAuthHooks(verifier, { csrf: env.CSRF_REQUIRED }),
    internalAuth: createInternalAuth(env.INTERNAL_SERVICE_SECRET),
    stats,
    leaderboard,
    async close() {
      await relay.stop();
      await producer.disconnect();
      redis.disconnect();
      await db.close();
    },
  };
}
