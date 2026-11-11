import { judgeEvents } from '@cb/contracts';
import { startLeaderLoop } from '@cb/db';
import { deadLetters, EventConsumer, on } from '@cb/events';
import { idempotencyKeys } from '@cb/idempotency';
import { newId } from '@cb/ids';
import { createWorker } from '@cb/queue';
import type { Worker } from 'bullmq';
import { lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SERVICE_TOPICS, type Infra } from './infra.js';
import { QUEUES } from './queues.js';

export interface WorkerHandle {
  consumer: EventConsumer;
  workers: Worker[];
  /** One reconciler pass (exposed for tests). */
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

const challengeJob = z.object({ challengeId: z.uuid() });
const matchJob = z.object({ matchId: z.uuid() });

/**
 * Background side: the judge-event consumer (submission read model → winner), challenge-expire
 * and match-timeout workers, and the leader-elected reconciler that needs neither Redis nor BullMQ.
 */
export async function startWorker(
  infra: Infra,
  opts: { fromBeginning?: boolean; reconcileEveryMs?: number } = {},
): Promise<WorkerHandle> {
  const { logger } = infra;
  const consumer = new EventConsumer({
    kafka: infra.kafka,
    db: infra.db.db,
    logger,
    groupId: infra.env.SERVICE_NAME,
    topics: SERVICE_TOPICS,
    handlers: [
      on(judgeEvents.submissionCreatedV1, (tx, env) => infra.matches.onSubmissionCreated(tx, env.data)),
      on(judgeEvents.submissionJudgedV1, async (tx, env) => {
        await infra.matches.onSubmissionJudged(tx, env.data);
        // the decision's outbox rows commit with the inbox; let the relay pick them up promptly
        setTimeout(() => infra.relay.kick(), 50).unref();
      }),
    ],
    fromBeginning: opts.fromBeginning ?? false,
  });
  await consumer.start();

  const deadLetter =
    (queue: string) =>
    async (job: { id?: string | undefined; data: unknown; attemptsMade: number }, err: Error) => {
      await infra.db.db.insert(deadLetters).values({
        id: newId(),
        source: `bullmq:${queue}`,
        payload: { jobId: job.id, data: job.data },
        error: String(err.stack ?? err),
        attempts: job.attemptsMade,
      });
    };
  const workers = [
    createWorker({
      name: QUEUES.challengeExpire,
      connection: infra.redis,
      logger,
      concurrency: 8,
      processor: async (job) => {
        await infra.challenges.expire(challengeJob.parse(job.data).challengeId);
      },
      onExhausted: deadLetter(QUEUES.challengeExpire),
    }),
    // both the timeout at ends_at and the deciding cap re-evaluate the match (plan §11.4)
    createWorker({
      name: QUEUES.matchTimeout,
      connection: infra.redis,
      logger,
      concurrency: 8,
      processor: async (job) => infra.matches.evaluate(matchJob.parse(job.data).matchId),
      onExhausted: deadLetter(QUEUES.matchTimeout),
    }),
  ];

  infra.relay.start();
  infra.dispatcher.start();

  const reconcile = async () => {
    const r = await infra.matches.reconcile();
    const expired = await infra.challenges.expireOverdue();
    if (r.aborted || r.evaluated || expired) logger.info({ ...r, expired }, 'reconciler pass');
  };
  // Plan §11.4: every 15 s, leader-elected through a Postgres advisory lock.
  const reconciler = startLeaderLoop({
    pool: infra.db.pool,
    name: 'battle-reconciler',
    intervalMs: opts.reconcileEveryMs ?? infra.env.RECONCILER_INTERVAL_MS,
    logger,
    task: reconcile,
  });
  const sweeper = startLeaderLoop({
    pool: infra.db.pool,
    name: `${infra.env.SERVICE_NAME}-idempotency-sweeper`,
    intervalMs: 60 * 60_000,
    logger,
    task: async () => {
      await infra.db.db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, sql`now()`));
    },
  });

  return {
    consumer,
    workers,
    reconcile,
    async stop() {
      await reconciler.stop();
      await sweeper.stop();
      await consumer.stop();
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
