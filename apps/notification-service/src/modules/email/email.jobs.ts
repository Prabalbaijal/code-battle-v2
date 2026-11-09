import { emailJobSchema } from '@cb/contracts';
import type { Job } from '@cb/queue';
import { DelayedError, UnrecoverableError } from 'bullmq';
import type { EmailService } from './email.service.js';

/** BullMQ processor for `email-send`. Idempotent via email_log; quota-aware via moveToDelayed. */
export const emailSendProcessor = (service: EmailService) => async (job: Job<unknown>, token?: string) => {
  const parsed = emailJobSchema.safeParse(job.data);
  // A malformed payload will never become valid: fail without retries.
  if (!parsed.success) throw new UnrecoverableError(`invalid email job: ${parsed.error.message}`);

  const out = await service.send(parsed.data);
  if (out.status === 'deferred') {
    if (!token) throw new Error('worker token required to defer a job');
    await job.moveToDelayed(out.until.getTime(), token);
    throw new DelayedError(); // tells BullMQ the job was rescheduled, not failed
  }
  return out;
};
