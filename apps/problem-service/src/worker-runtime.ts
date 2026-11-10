import { deadLetters } from '@cb/events';
import { newId } from '@cb/ids';
import { createWorker } from '@cb/queue';
import type { Worker } from 'bullmq';
import { z } from 'zod';
import type { Infra } from './infra.js';
import { CALIBRATE_QUEUE } from './modules/calibration/calibration.service.js';

export interface WorkerHandle {
  calibrateWorker: Worker;
  stop(): Promise<void>;
}

const calibrateJob = z.object({ calibrationId: z.uuid() });

/**
 * Background side: the outbox relay, the job dispatcher and the problem-calibrate worker.
 * (The battle.match.started.v1 "seen" consumer joins in Phase 3.)
 */
export async function startWorker(infra: Infra): Promise<WorkerHandle> {
  const calibrateWorker = createWorker({
    name: CALIBRATE_QUEUE,
    connection: infra.queueRedis,
    logger: infra.logger,
    concurrency: 2,
    processor: async (job) => infra.calibration.run(calibrateJob.parse(job.data).calibrationId),
    onExhausted: async (job, err) => {
      await infra.db.db.insert(deadLetters).values({
        id: newId(),
        source: `bullmq:${CALIBRATE_QUEUE}`,
        payload: { jobId: job.id, data: job.data },
        error: String(err.stack ?? err),
        attempts: job.attemptsMade,
      });
    },
  });
  infra.relay.start();
  infra.dispatcher.start();
  return {
    calibrateWorker,
    async stop() {
      await calibrateWorker.close();
    },
  };
}
