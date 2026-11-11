import { createAuthHooks, createInternalAuth, JwtVerifier, type AuthHooks } from '@cb/auth';
import { createKafka } from '@cb/events';
import type { Logger } from '@cb/logger';
import { createRedis, SafeRedis, type Redis } from '@cb/redis';
import type { FastifyRequest } from 'fastify';
import type { Kafka } from 'kafkajs';
import type { Env } from './config/env.js';
import { HttpDirectory, type Directory } from './directory.js';
import { PresenceStore } from './presence.js';

/** realtime has no database: Redis for presence, Kafka for delivery (plan §8.9). */
export interface Infra {
  env: Env;
  logger: Logger;
  redis: Redis;
  safeRedis: SafeRedis;
  /** Pub/sub needs its own connection. */
  subscriber: Redis;
  kafka: Kafka;
  verifier: JwtVerifier;
  authHooks: AuthHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
  store: PresenceStore;
  directory: Directory;
  close(): Promise<void>;
}

export interface InfraOptions {
  verifier?: JwtVerifier;
  directory?: Directory;
}

export async function createInfra(env: Env, logger: Logger, opts: InfraOptions = {}): Promise<Infra> {
  const redis = createRedis({ url: env.REDIS_URL, role: 'presence', logger, name: env.SERVICE_NAME });
  // subscriber: queue-style options (offline queue on) so SUBSCRIBE survives reconnects
  const subscriber = createRedis({
    url: env.REDIS_URL,
    role: 'queue',
    logger,
    name: `${env.SERVICE_NAME}-sub`,
  });
  const safeRedis = new SafeRedis(redis, logger);
  const kafka = createKafka({
    clientId: `${env.SERVICE_NAME}-${env.NODE_ID}`,
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
  const verifier = opts.verifier ?? new JwtVerifier({ jwksUrl: env.JWKS_URL });
  return {
    env,
    logger,
    redis,
    safeRedis,
    subscriber,
    kafka,
    verifier,
    authHooks: createAuthHooks(verifier, { csrf: env.CSRF_REQUIRED }),
    internalAuth: createInternalAuth(env.INTERNAL_SERVICE_SECRET),
    store: new PresenceStore(safeRedis, env.NODE_ID),
    directory:
      opts.directory ??
      new HttpDirectory({
        baseUrl: env.USER_SERVICE_URL,
        secret: env.INTERNAL_SERVICE_SECRET,
        service: env.SERVICE_NAME,
      }),
    async close() {
      redis.disconnect();
      subscriber.disconnect();
    },
  };
}
