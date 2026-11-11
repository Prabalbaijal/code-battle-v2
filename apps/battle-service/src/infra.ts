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
import {
  HttpJudgeCapacity,
  HttpPresence,
  HttpProblemSelector,
  HttpUserDirectory,
  type JudgeCapacity,
  type PresenceSource,
  type ProblemSelector,
  type UserDirectory,
} from './clients.js';
import type { Env } from './config/env.js';
import { ChallengeService } from './modules/challenges/challenges.service.js';
import { MatchService } from './modules/matches/matches.service.js';
import { TabLeaseService } from './modules/matches/tab-lease.js';
import { QUEUES } from './queues.js';

/** battle-service consumes judge events (the submission read model). */
export const SERVICE_TOPICS = [TOPICS.judge];

export interface Infra {
  env: Env;
  logger: Logger;
  db: DbHandle;
  redis: Redis;
  safeRedis: SafeRedis;
  kafka: Kafka;
  producer: Producer;
  queues: Record<string, Queue>;
  outbox: OutboxWriter;
  relay: OutboxRelay;
  dispatcher: JobOutboxDispatcher;
  authHooks: AuthHooks;
  internalAuth: (req: FastifyRequest) => Promise<void>;
  challenges: ChallengeService;
  matches: MatchService;
  tabLease: TabLeaseService;
  close(): Promise<void>;
}

export interface InfraOptions {
  verifier?: JwtVerifier;
  problems?: ProblemSelector;
  judge?: JudgeCapacity;
  users?: UserDirectory;
  presence?: PresenceSource;
}

export async function createInfra(env: Env, logger: Logger, opts: InfraOptions = {}): Promise<Infra> {
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: env.SERVICE_NAME, logger });
  const redis = createRedis({ url: env.REDIS_URL, role: 'queue', logger, name: env.SERVICE_NAME });
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
  const queues: Record<string, Queue> = {
    [QUEUES.challengeExpire]: createQueue(QUEUES.challengeExpire, redis, { attempts: 5 }),
    [QUEUES.matchTimeout]: createQueue(QUEUES.matchTimeout, redis, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
    }),
  };
  const outbox = createOutboxWriter(env.SERVICE_NAME);
  const relay = new OutboxRelay({ db: db.db, producer, logger });
  const dispatcher = new JobOutboxDispatcher({ db: db.db, logger, queues });
  const afterCommit = () => {
    relay.kick();
    dispatcher.kick();
  };

  const internal = { secret: env.INTERNAL_SERVICE_SECRET, service: env.SERVICE_NAME };
  const users = opts.users ?? new HttpUserDirectory({ baseUrl: env.USER_SERVICE_URL, ...internal });
  const challenges = new ChallengeService({
    db: db.db,
    outbox,
    logger,
    users,
    presence: opts.presence ?? new HttpPresence({ baseUrl: env.REALTIME_SERVICE_URL, ...internal }, logger),
    judge: opts.judge ?? new HttpJudgeCapacity({ baseUrl: env.JUDGE_SERVICE_URL, ...internal }),
    challengeTtlMs: env.CHALLENGE_TTL_SECONDS * 1000,
    afterCommit,
  });
  const matches = new MatchService({
    db: db.db,
    outbox,
    logger,
    users,
    problems: opts.problems ?? new HttpProblemSelector({ baseUrl: env.PROBLEM_SERVICE_URL, ...internal }),
    matchDurationSec: env.MATCH_DURATION_SECONDS,
    decideCapSec: env.DECIDE_CAP_SECONDS,
    afterCommit,
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
    queues,
    outbox,
    relay,
    dispatcher,
    authHooks: createAuthHooks(verifier, { csrf: env.CSRF_REQUIRED }),
    internalAuth: createInternalAuth(env.INTERNAL_SERVICE_SECRET),
    challenges,
    matches,
    tabLease: new TabLeaseService({ redis: safeRedis, matches }),
    async close() {
      await relay.stop();
      await dispatcher.stop();
      await Promise.all(Object.values(queues).map((q) => q.close()));
      await producer.disconnect();
      redis.disconnect();
      await db.close();
    },
  };
}
