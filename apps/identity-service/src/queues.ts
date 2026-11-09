import { EMAIL_QUEUE } from '@cb/contracts';

/** BullMQ queues this service produces to (via its job outbox). Names use hyphens (no colons). */
export const QUEUES = {
  /** Consumed by notification-service. */
  email: EMAIL_QUEUE,
} as const;
