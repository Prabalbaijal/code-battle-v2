import type { Job } from '@cb/queue';
import { z } from 'zod';
import type { GreetingService } from './greeting.service.js';

const ackJobData = z.object({ greetingId: z.uuid() });

/** BullMQ processor for QUEUES.greetingAck. Idempotent: re-runs are no-ops. */
export const greetingAckProcessor = (service: GreetingService) => async (job: Job<unknown>) => {
  const { greetingId } = ackJobData.parse(job.data);
  return { applied: await service.processAckJob(greetingId) };
};
