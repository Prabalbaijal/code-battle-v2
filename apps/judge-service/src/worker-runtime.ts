import { startLeaderLoop } from '@cb/db';
import { deadLetters } from '@cb/events';
import { newId } from '@cb/ids';
import { createWorker } from '@cb/queue';
import type { Worker } from 'bullmq';
import { z } from 'zod';
import type { Infra } from './infra.js';
import { judgingRepository } from './modules/judging/judging.repository.js';
import { QUEUES } from './queues.js';

export interface WorkerHandle {
  submitWorker: Worker;
  pollWorker: Worker;
  driftWorker: Worker;
  /** One pass of the stuck-submission sweeper (exposed for tests). */
  sweep(): Promise<void>;
  /** One pass of the degraded-mode loop (exposed for tests). */
  degradedTick(): Promise<void>;
  stop(): Promise<void>;
}

const submitJob = z.object({ submissionId: z.uuid() });
const pollJob = z.object({ submissionId: z.uuid(), n: z.number().int().min(0) });

/**
 * Background side: judge-submit and judge-poll workers, the outbox relay + job dispatcher, and a
 * leader-elected sweeper that re-polls submissions whose poll job got lost (crash, Redis restart).
 */
export async function startWorker(
  infra: Infra,
  opts: { bootstrapRetries?: number } = {},
): Promise<WorkerHandle> {
  const { logger } = infra;
  for (let attempt = 0; ; attempt++) {
    try {
      await infra.bootstrapJudge0();
      break;
    } catch (err) {
      if (attempt >= (opts.bootstrapRetries ?? 30)) throw err;
      logger.warn({ err }, 'Judge0 not reachable yet; retrying');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

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

  const submitWorker = createWorker({
    name: QUEUES.submit,
    connection: infra.queueRedis,
    logger,
    concurrency: 4,
    processor: async (job) => infra.judging.start(submitJob.parse(job.data).submissionId),
    onExhausted: deadLetter(QUEUES.submit),
  });
  const pollWorker = createWorker({
    name: QUEUES.poll,
    connection: infra.queueRedis,
    logger,
    concurrency: 8,
    processor: async (job) => {
      const { submissionId, n } = pollJob.parse(job.data);
      await infra.judging.sync(submissionId, n);
    },
    onExhausted: deadLetter(QUEUES.poll),
  });

  const driftWorker = createWorker({
    name: QUEUES.drift,
    connection: infra.queueRedis,
    logger,
    concurrency: 1,
    processor: async () => {
      await infra.drift.check();
    },
    onExhausted: deadLetter(QUEUES.drift),
  });
  // Weekly, Monday 03:00 UTC (plan §14.8). Upserting keeps a single schedule across restarts.
  await infra.queues[QUEUES.drift]!.upsertJobScheduler(
    'judge-drift-weekly',
    { pattern: '0 3 * * 1', tz: 'UTC' },
    { name: 'check' },
  ).catch((err: unknown) => logger.warn({ err }, 'could not schedule the drift check'));
  // Other processes may have run a check: pick up the factor in force every 5 minutes.
  const refresh = setInterval(() => {
    infra.drift.load().catch((err: unknown) => logger.warn({ err }, 'could not load the drift factor'));
  }, 5 * 60_000);
  refresh.unref();

  infra.relay.start();
  infra.dispatcher.start();

  const sweep = async () => {
    await infra.breakers.sweep();
    if (!infra.queueHealthy()) return; // the degraded loop covers this
    for (const id of await judgingRepository.stuckSubmissions(infra.db.db, 120)) {
      await infra.queues[QUEUES.poll]!.add(
        'sync',
        { submissionId: id, n: 0 },
        { jobId: `sweep-${id}-${Date.now()}` },
      );
    }
  };
  const leader = startLeaderLoop({
    pool: infra.db.pool,
    name: `${infra.env.SERVICE_NAME}-sweeper`,
    intervalMs: 60_000,
    logger,
    task: sweep,
  });

  /**
   * Degraded mode (plan §18.1): while the BullMQ Redis is down, judge straight from Postgres —
   * claim queued submissions (SKIP LOCKED) and poll running ones. When Redis is back, the job-outbox
   * dispatcher re-enqueues with the same job ids and the leftover jobs are no-ops.
   */
  let warned = false;
  const degradedTick = async () => {
    if (infra.queueHealthy()) {
      if (warned) logger.info('queue is back; leaving degraded mode');
      warned = false;
      return;
    }
    if (!warned) logger.warn('queue unavailable; judging from Postgres (degraded mode)');
    warned = true;
    for (let i = 0; i < 10 && (await infra.judging.startNextQueued()); i++);
    for (const id of await judgingRepository.runningSubmissionIds(infra.db.db, 50)) {
      await infra.judging
        .syncWithoutQueue(id)
        .catch((err: unknown) => logger.warn({ err, submissionId: id }, 'degraded sync failed'));
    }
  };
  const degraded = startLeaderLoop({
    pool: infra.db.pool,
    name: `${infra.env.SERVICE_NAME}-degraded`,
    intervalMs: 2000,
    logger,
    task: degradedTick,
  });

  return {
    submitWorker,
    pollWorker,
    driftWorker,
    sweep,
    degradedTick,
    async stop() {
      clearInterval(refresh);
      await degraded.stop();
      await leader.stop();
      await submitWorker.close();
      await pollWorker.close();
      await driftWorker.close();
    },
  };
}
