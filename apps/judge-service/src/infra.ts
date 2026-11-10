import { createAuthHooks, createInternalAuth, JwtVerifier, type AuthHooks } from '@cb/auth';
import { TOPICS } from '@cb/contracts';
import { createDb, type DbHandle } from '@cb/db';
import { createKafka, createOutboxWriter, createProducer, OutboxRelay, type OutboxWriter } from '@cb/events';
import type { Logger } from '@cb/logger';
import { createQueue, JobOutboxDispatcher } from '@cb/queue';
import { RateLimiter } from '@cb/rate-limit';
import { createRedis, SafeRedis, type Redis } from '@cb/redis';
import type { Queue } from 'bullmq';
import type { FastifyRequest } from 'fastify';
import type { Kafka, Producer } from 'kafkajs';
import type { Env } from './config/env.js';
import { Judge0HttpExecutor, type CodeExecutor } from './judge0/executor.js';
import { LANGUAGE_RULES, resolveLanguages } from './judge0/languages.js';
import { judgingRepository } from './modules/judging/judging.repository.js';
import { JudgingService } from './modules/judging/judging.service.js';
import { SubmissionService } from './modules/submissions/submissions.service.js';
import { ProblemServiceSource, type ProblemSource } from './problems/problem-source.js';
import { QUEUES } from './queues.js';

export const SERVICE_TOPICS = [TOPICS.judge];

export interface Infra {
  env: Env;
  logger: Logger;
  db: DbHandle;
  queueRedis: Redis;
  safeRedis: SafeRedis;
  kafka: Kafka;
  producer: Producer;
  queues: Record<string, Queue>;
  outbox: OutboxWriter;
  relay: OutboxRelay;
  dispatcher: JobOutboxDispatcher;
  executor: CodeExecutor;
  problems: ProblemSource;
  authHooks: AuthHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
  limits: { submit: RateLimiter; run: RateLimiter };
  judging: JudgingService;
  submissions: SubmissionService;
  /** Read Judge0's limits and languages; upsert language profiles. Retries are the caller's job. */
  bootstrapJudge0(): Promise<void>;
  close(): Promise<void>;
}

export interface InfraOptions {
  verifier?: JwtVerifier;
  problems?: ProblemSource;
  executor?: CodeExecutor;
  /** Tests replace the per-user submit/run limits. */
  limits?: { submit: RateLimiter; run: RateLimiter };
}

export async function createInfra(env: Env, logger: Logger, opts: InfraOptions = {}): Promise<Infra> {
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
  const queues: Record<string, Queue> = {
    [QUEUES.submit]: createQueue(QUEUES.submit, queueRedis, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
    }),
    [QUEUES.poll]: createQueue(QUEUES.poll, queueRedis, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    }),
  };
  const outbox = createOutboxWriter(env.SERVICE_NAME);
  const relay = new OutboxRelay({ db: db.db, producer, logger });
  const dispatcher = new JobOutboxDispatcher({ db: db.db, logger, queues });
  const afterCommit = () => {
    relay.kick();
    dispatcher.kick();
  };

  const executor =
    opts.executor ??
    new Judge0HttpExecutor({
      baseUrl: env.JUDGE0_URL,
      auth: env.JUDGE0_AUTH,
      ...(env.JUDGE0_API_KEY ? { apiKey: env.JUDGE0_API_KEY } : {}),
    });
  const problems =
    opts.problems ??
    new ProblemServiceSource({
      baseUrl: env.PROBLEM_SERVICE_URL,
      secret: env.INTERNAL_SERVICE_SECRET,
      service: env.SERVICE_NAME,
    });

  const verifier = opts.verifier ?? new JwtVerifier({ jwksUrl: env.JWKS_URL });
  const authHooks = createAuthHooks(verifier, { csrf: env.CSRF_REQUIRED });
  const internalAuth = createInternalAuth(env.INTERNAL_SERVICE_SECRET);
  const limits = opts.limits ?? {
    submit: new RateLimiter({
      redis: safeRedis,
      logger,
      prefix: 'judge:submit',
      capacity: 1,
      refillPerSec: 1 / 5,
    }),
    run: new RateLimiter({
      redis: safeRedis,
      logger,
      prefix: 'judge:run',
      capacity: 6,
      refillPerSec: 6 / 60,
    }),
  };

  const judging = new JudgingService({
    db: db.db,
    executor,
    problems,
    outbox,
    logger,
    pollQueue: queues[QUEUES.poll]!,
    mode: env.JUDGE0_MODE,
    ...(env.JUDGE0_CALLBACK_BASE_URL ? { callbackBaseUrl: env.JUDGE0_CALLBACK_BASE_URL } : {}),
    ...(env.JUDGE0_CALLBACK_SECRET ? { callbackSecret: env.JUDGE0_CALLBACK_SECRET } : {}),
    dailyBudget: env.JUDGE0_DAILY_BUDGET,
    afterCommit,
  });
  const submissions = new SubmissionService({
    db: db.db,
    outbox,
    problems,
    executor,
    dailyBudget: env.JUDGE0_DAILY_BUDGET,
    matchReserveCalls: env.MATCH_RESERVE_CALLS,
    maxSubmitsPerMatch: env.MAX_SUBMITS_PER_MATCH,
    afterCommit,
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
    executor,
    problems,
    authHooks,
    internalAuth,
    limits,
    judging,
    submissions,
    async bootstrapJudge0() {
      const info = await executor.info();
      const resolved = resolveLanguages(info.languages);
      await judgingRepository.upsertProfiles(
        db.db,
        resolved.map((l) => ({
          languageKey: l.key,
          judge0LanguageId: l.judge0Id,
          name: l.name,
          defaultTimeFactor: LANGUAGE_RULES[l.key].timeFactor.toFixed(1),
          memOverheadKb: LANGUAGE_RULES[l.key].memOverheadKb,
          maxProcesses: LANGUAGE_RULES[l.key].maxProcesses,
        })),
      );
      judging.configure(info.instance, info.maxBatch);
      await judging.loadProfiles();
      const missing = Object.keys(LANGUAGE_RULES).filter((k) => !resolved.some((r) => r.key === k));
      logger.info(
        { languages: resolved.map((r) => `${r.key}=${r.judge0Id}`), missing, instance: info.instance },
        'judge0 ready',
      );
    },
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
