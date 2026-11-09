import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Infra tables every service owns (outbox, inbox, dead letters, job outbox, idempotency keys).
export { deadLetters, outbox, processedEvents } from '@cb/events';
export { idempotencyKeys } from '@cb/idempotency';
export { jobOutbox } from '@cb/queue';

/** Example aggregate. Replace with the service's own tables when copying the template. */
export const greetings = pgTable('greetings', {
  id: uuid('id').primaryKey(),
  authorId: text('author_id').notNull(),
  message: text('message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set by the Kafka consumer (proves outbox → relay → Kafka → inbox). */
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  ackCount: integer('ack_count').notNull().default(0),
  /** Set by the BullMQ job (proves job outbox → dispatcher → worker). */
  jobProcessedAt: timestamp('job_processed_at', { withTimezone: true }),
});

export type Greeting = typeof greetings.$inferSelect;
