import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Job outbox: BullMQ jobs are written here inside the business transaction and dispatched after
 * commit, so "intent to run a job" survives Redis outages and crashes (plan §10.3, §18.1).
 */
export const jobOutbox = pgTable(
  'job_outbox',
  {
    id: uuid('id').primaryKey(),
    queue: text('queue').notNull(),
    jobId: text('job_id').notNull(),
    name: text('name').notNull(),
    data: jsonb('data').notNull(),
    /** Absolute time the job should run (delay is computed at dispatch time). */
    runAt: timestamp('run_at', { withTimezone: true }),
    priority: integer('priority'),
    traceparent: text('traceparent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('job_outbox_queue_job_id_uq').on(t.queue, t.jobId),
    index('job_outbox_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.dispatchedAt} is null`),
  ],
);
