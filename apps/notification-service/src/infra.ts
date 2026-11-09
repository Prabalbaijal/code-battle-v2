import { createDb, type DbHandle } from '@cb/db';
import type { Logger } from '@cb/logger';
import { createRedis, SafeRedis, type Redis } from '@cb/redis';
import type { Env } from './config/env.js';
import { EmailService } from './modules/email/email.service.js';
import { BrevoProvider, FakeInboxProvider, type EmailProvider } from './modules/email/providers.js';

/**
 * Composition root shared by the API and the worker. Phase 1 covers email only; in-app
 * notifications (Kafka consumers) arrive in Phase 4.
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
  opts: { wrapProvider?: (p: EmailProvider) => EmailProvider } = {},
): Promise<Infra> {
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: env.SERVICE_NAME, logger });
  const queueRedis = createRedis({ url: env.REDIS_URL, role: 'queue', logger, name: env.SERVICE_NAME });
  const safeRedis = new SafeRedis(queueRedis, logger);
  const configured = createProvider(env, db);
  const provider = opts.wrapProvider ? opts.wrapProvider(configured) : configured;
  const email = new EmailService({ db: db.db, provider, logger, dailyCap: env.EMAIL_DAILY_CAP });
  logger.info({ provider: provider.name }, 'email provider');

  return {
    env,
    logger,
    db,
    queueRedis,
    safeRedis,
    provider,
    email,
    async close() {
      queueRedis.disconnect();
      await db.close();
    },
  };
}
