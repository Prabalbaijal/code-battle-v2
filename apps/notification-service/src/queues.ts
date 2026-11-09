import { EMAIL_QUEUE } from '@cb/contracts';

/** BullMQ queues this service consumes. Names use hyphens (no colons). */
export const QUEUES = {
  /** Produced by identity-service (job outbox). */
  email: EMAIL_QUEUE,
} as const;
