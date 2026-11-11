import { createAuthHooks, JwtVerifier, type AuthHooks } from '@cb/auth';
import { TOPICS } from '@cb/contracts';
import { createDb, type DbHandle } from '@cb/db';
import { createKafka, createOutboxWriter, createProducer, OutboxRelay, type OutboxWriter } from '@cb/events';
import type { Logger } from '@cb/logger';
import { createRedis, SafeRedis, type Redis } from '@cb/redis';
import type { Kafka, Producer } from 'kafkajs';
import type { Env } from './config/env.js';
import { EmailService } from './modules/email/email.service.js';
import { BrevoProvider, FakeInboxProvider, type EmailProvider } from './modules/email/providers.js';
import { NotificationService } from './modules/inapp/notifications.service.js';
import { HttpUserDirectory, type UserDirectory } from './modules/inapp/users.js';

/** In-app notifications come from friendships (user), challenges and results (battle), coins (rating). */
export const SERVICE_TOPICS = [TOPICS.user, TOPICS.battle, TOPICS.rating];

/**
 * Composition root shared by the API and the worker: email (BullMQ jobs from identity) and
 * in-app notifications (Kafka consumers + outbox → realtime).
 */
export interface Infra {
  env: Env;
  logger: Logger;
  db: DbHandle;
  /** BullMQ connection. */
  queueRedis: Redis;
  safeRedis: SafeRedis;
  provider: EmailProvider;
  email: EmailService;
  kafka: Kafka;
  producer: Producer;
  outbox: OutboxWriter;
  relay: OutboxRelay;
  authHooks: AuthHooks;
  notifications: NotificationService;
  close(): Promise<void>;
}

export function createProvider(env: Env, db: DbHandle): EmailProvider {
  if (env.EMAIL_PROVIDER === 'brevo') {
    return new BrevoProvider({
      apiKey: env.BREVO_API_KEY!,
      apiUrl: env.BREVO_API_URL,
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME },
    });
  }
  return new FakeInboxProvider(db.db);
}

export async function createInfra(
  env: Env,
  logger: Logger,
  /** Tests wrap the configured provider to inject failures. */
  opts: {
    wrapProvider?: (p: EmailProvider) => EmailProvider;
    verifier?: JwtVerifier;
    users?: UserDirectory;
  } = {},
): Promise<Infra> {
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: env.SERVICE_NAME, logger });
  const queueRedis = createRedis({ url: env.REDIS_URL, role: 'queue', logger, name: env.SERVICE_NAME });
  const safeRedis = new SafeRedis(queueRedis, logger);
  const configured = createProvider(env, db);
  const provider = opts.wrapProvider ? opts.wrapProvider(configured) : configured;
  const email = new EmailService({ db: db.db, provider, logger, dailyCap: env.EMAIL_DAILY_CAP });
  logger.info({ provider: provider.name }, 'email provider');

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
  const notifications = new NotificationService({ db: db.db, outbox, users, logger });
  const verifier = opts.verifier ?? new JwtVerifier({ jwksUrl: env.JWKS_URL });

  return {
    env,
    logger,
    db,
    queueRedis,
    safeRedis,
    provider,
    email,
    kafka,
    producer,
    outbox,
    relay,
    authHooks: createAuthHooks(verifier, { csrf: env.CSRF_REQUIRED }),
    notifications,
    async close() {
      await relay.stop();
      await producer.disconnect();
      queueRedis.disconnect();
      await db.close();
    },
  };
}
