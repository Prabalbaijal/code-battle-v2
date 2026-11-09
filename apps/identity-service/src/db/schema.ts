import { sql } from 'drizzle-orm';
import { check, customType, index, inet, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Infra tables every service owns (outbox, inbox, dead letters, job outbox, idempotency keys).
export { deadLetters, outbox, processedEvents } from '@cb/events';
export { idempotencyKeys } from '@cb/idempotency';
export { jobOutbox } from '@cb/queue';

/** Case-insensitive text (extension created in the first migration). */
const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Plan §9.1. Owns email + username uniqueness (atomic on registration). */
export const credentials = pgTable(
  'credentials',
  {
    userId: uuid('user_id').primaryKey(),
    email: citext('email').notNull().unique('credentials_email_key'),
    username: citext('username').notNull().unique('credentials_username_key'),
    fullname: text('fullname').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordAlgo: text('password_algo', { enum: ['argon2id', 'bcrypt'] })
      .notNull()
      .default('argon2id'),
    role: text('role', { enum: ['user', 'problem_setter', 'admin'] })
      .notNull()
      .default('user'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    status: text('status', { enum: ['active', 'locked', 'disabled'] })
      .notNull()
      .default('active'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** Migration only (plan §24). */
    legacyMongoId: text('legacy_mongo_id').unique('credentials_legacy_mongo_id_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('credentials_username_format', sql`${t.username} ~ '^[a-zA-Z0-9_]{3,20}$'`),
    check('credentials_password_algo', sql`${t.passwordAlgo} in ('argon2id','bcrypt')`),
    check('credentials_role', sql`${t.role} in ('user','problem_setter','admin')`),
    check('credentials_status', sql`${t.status} in ('active','locked','disabled')`),
  ],
);

/** Opaque refresh tokens, stored as sha256. `family_id` = rotation chain (reuse ⇒ revoke family). */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => credentials.userId),
    familyId: uuid('family_id').notNull(),
    tokenHash: bytea('token_hash').notNull().unique('refresh_tokens_token_hash_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('refresh_tokens_user_id_idx').on(t.userId),
    index('refresh_tokens_family_id_idx').on(t.familyId),
  ],
);

/** Email verification and password reset tokens; consumed with one conditional UPDATE. */
export const oneTimeTokens = pgTable(
  'one_time_tokens',
  {
    tokenHash: bytea('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => credentials.userId),
    purpose: text('purpose', { enum: ['verify_email', 'reset_password'] }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('one_time_tokens_user_id_idx').on(t.userId),
    check('one_time_tokens_purpose', sql`${t.purpose} in ('verify_email','reset_password')`),
  ],
);

export type Credential = typeof credentials.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type TokenPurpose = (typeof oneTimeTokens.$inferSelect)['purpose'];
