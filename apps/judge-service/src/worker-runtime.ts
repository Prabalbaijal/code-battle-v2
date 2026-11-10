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
  /** One pass of the stuck-submission sweeper (exposed for tests). */
  sweep(): Promise<void>;
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

  infra.relay.start();
  infra.dispatcher.start();

  const sweep = async () => {
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

  return {
    submitWorker,
    pollWorker,
    sweep,
    async stop() {
      await leader.stop();
      await submitWorker.close();
      await pollWorker.close();
    },
  };
}
