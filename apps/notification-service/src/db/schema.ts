import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Infra tables every service owns (outbox, inbox, dead letters, job outbox, idempotency keys).
export { deadLetters, outbox, processedEvents } from '@cb/events';
export { idempotencyKeys } from '@cb/idempotency';
export { jobOutbox } from '@cb/queue';

/**
 * One row per logical email (plan §9.7). `dedupe_key` makes sending idempotent across BullMQ
 * retries and duplicate jobs. The recipient is stored only as a hash.
 *   pending → sending → sent | failed   (pending again after a retryable error)
 */
export const emailLog = pgTable(
  'email_log',
  {
    dedupeKey: text('dedupe_key').primaryKey(),
    template: text('template').notNull(),
    toHash: text('to_hash').notNull(),
    status: text('status', { enum: ['pending', 'sending', 'sent', 'failed'] }).notNull(),
    provider: text('provider').notNull(),
    providerMessageId: text('provider_message_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    check('email_log_status', sql`${t.status} in ('pending','sending','sent','failed')`),
    // daily quota check: count of sent mail since midnight UTC
    index('email_log_sent_at_idx').on(t.sentAt),
  ],
);

/** Mail captured by the fake provider (never used in production). Read via GET /internal/dev/inbox. */
export const fakeInbox = pgTable(
  'fake_inbox',
  {
    id: uuid('id').primaryKey(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('fake_inbox_to_idx').on(t.to, t.createdAt)],
);

export type EmailLog = typeof emailLog.$inferSelect;

/**
 * In-app notifications (plan §9.7). `UNIQUE (user_id, dedupe_key)` keeps a re-published event
 * from creating a second row (the inbox already drops redeliveries of the same envelope).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notifications_once').on(t.userId, t.dedupeKey),
    index('notifications_unread')
      .on(t.userId, t.createdAt.desc())
      .where(sql`${t.readAt} is null`),
    index('notifications_user_idx').on(t.userId, t.createdAt.desc(), t.id),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
