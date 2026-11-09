import { createAuthHooks, createInternalAuth, JwtVerifier, type AuthHooks } from '@cb/auth';
import { TOPICS } from '@cb/contracts';
import { createDb, type DbHandle } from '@cb/db';
import { createKafka, createOutboxWriter, createProducer, OutboxRelay, type OutboxWriter } from '@cb/events';
import type { Logger } from '@cb/logger';
import { RateLimiter } from '@cb/rate-limit';
import { createRedis, SafeRedis, type Redis } from '@cb/redis';
import type { FastifyRequest } from 'fastify';
import type { Kafka, Producer } from 'kafkajs';
import type { Env } from './config/env.js';
import { FriendsService } from './modules/friends/friends.service.js';
import { AvatarUploads } from './modules/profile/avatar.js';
import { ProfileService } from './modules/profile/profile.service.js';

/** Publishes friendship/profile events and consumes identity's registrations, all on `user.events`. */
export const SERVICE_TOPICS = [TOPICS.user];

export interface Infra {
  env: Env;
  logger: Logger;
  db: DbHandle;
  cacheRedis: Redis;
  safeRedis: SafeRedis;
  kafka: Kafka;
  producer: Producer;
  outbox: OutboxWriter;
  relay: OutboxRelay;
  authHooks: AuthHooks;
  internalAuth?: (req: FastifyRequest) => Promise<void>;
  limits: { search: RateLimiter; friendRequests: RateLimiter };
  profiles: ProfileService;
  friends: FriendsService;
  close(): Promise<void>;
}

export interface InfraOptions {
  /** Tests verify tokens against a local key set instead of identity's JWKS URL. */
  verifier?: JwtVerifier;
}

export async function createInfra(env: Env, logger: Logger, opts: InfraOptions = {}): Promise<Infra> {
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: env.SERVICE_NAME, logger });
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
  const outbox = createOutboxWriter(env.SERVICE_NAME);
  const relay = new OutboxRelay({ db: db.db, producer, logger });
  const afterCommit = () => relay.kick();

  const verifier = opts.verifier ?? new JwtVerifier({ jwksUrl: env.JWKS_URL });
  const authHooks = createAuthHooks(verifier, { csrf: env.CSRF_REQUIRED });
  const internalAuth = env.INTERNAL_SERVICE_SECRET
    ? createInternalAuth(env.INTERNAL_SERVICE_SECRET)
    : undefined;

  const per = (prefix: string, capacity: number, windowSec: number) =>
    new RateLimiter({
      redis: safeRedis,
      logger,
      prefix: `users:${prefix}`,
      capacity,
      refillPerSec: capacity / windowSec,
    });
  const limits = { search: per('search', 60, 60), friendRequests: per('friend-req', 30, 3600) };

  const avatars = new AvatarUploads(
    env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
      ? {
          cloudName: env.CLOUDINARY_CLOUD_NAME,
          apiKey: env.CLOUDINARY_API_KEY,
          apiSecret: env.CLOUDINARY_API_SECRET,
          folder: env.CLOUDINARY_FOLDER,
        }
      : undefined,
  );
  if (!avatars.enabled) logger.warn('Cloudinary not configured: avatar uploads disabled');

  const profiles = new ProfileService({ db: db.db, outbox, avatars, afterCommit });
  const friends = new FriendsService({ db: db.db, outbox, afterCommit });

  return {
    env,
    logger,
    db,
    cacheRedis,
    safeRedis,
    kafka,
    producer,
    outbox,
    relay,
    authHooks,
    ...(internalAuth ? { internalAuth } : {}),
    limits,
    profiles,
    friends,
    async close() {
      await relay.stop();
      await producer.disconnect();
      cacheRedis.disconnect();
      await db.close();
    },
  };
}
