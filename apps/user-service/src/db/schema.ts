import { sql } from 'drizzle-orm';
import { check, customType, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Infra tables every service owns (outbox, inbox, dead letters, job outbox, idempotency keys).
export { deadLetters, outbox, processedEvents } from '@cb/events';
export { idempotencyKeys } from '@cb/idempotency';
export { jobOutbox } from '@cb/queue';

/** Case-insensitive text (citext + pg_trgm extensions are created in the first migration). */
const citext = customType<{ data: string }>({ dataType: () => 'citext' });

/** Plan §9.2. Created from `identity.user.registered.v1`; username is an immutable replica. */
export const profiles = pgTable(
  'profiles',
  {
    userId: uuid('user_id').primaryKey(),
    username: citext('username').notNull().unique('profiles_username_key'),
    fullname: text('fullname').notNull(),
    avatarUrl: text('avatar_url'),
    bio: text('bio'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // fuzzy search ("did you mean")
    index('profiles_username_trgm').using('gin', sql`${t.username} gin_trgm_ops`),
    // prefix search: lower(username) LIKE 'abc%' with keyset pagination
    index('profiles_username_prefix').on(sql`lower(${t.username}::text) text_pattern_ops`),
  ],
);

/**
 * One row per unordered pair (user_low < user_high), so A→B and B→A can never both exist.
 * pending → accepted | ignored; ignored → pending (re-request). Cancel/remove delete the row.
 */
export const friendships = pgTable(
  'friendships',
  {
    userLow: uuid('user_low').notNull(),
    userHigh: uuid('user_high').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'ignored'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'friendships_pkey', columns: [t.userLow, t.userHigh] }),
    check('friendships_ordered', sql`${t.userLow} < ${t.userHigh}`),
    check('friendships_requester', sql`${t.requestedBy} in (${t.userLow}, ${t.userHigh})`),
    check('friendships_status', sql`${t.status} in ('pending','accepted','ignored')`),
    index('friendships_high_status_idx').on(t.userHigh, t.status),
    index('friendships_low_status_idx').on(t.userLow, t.status),
  ],
);

export type ProfileRow = typeof profiles.$inferSelect;
export type FriendshipRow = typeof friendships.$inferSelect;
