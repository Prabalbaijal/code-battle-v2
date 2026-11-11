import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Infra tables every service owns (outbox, inbox, dead letters, job outbox, idempotency keys).
export { deadLetters, outbox, processedEvents } from '@cb/events';
export { idempotencyKeys } from '@cb/idempotency';
export { jobOutbox } from '@cb/queue';

const tsz = (name: string) => timestamp(name, { withTimezone: true });

/** Plan §9.4. At most one pending challenge per ordered pair (partial unique index). */
export const challenges = pgTable(
  'challenges',
  {
    id: uuid('id').primaryKey(),
    fromUser: uuid('from_user').notNull(),
    toUser: uuid('to_user').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'rejected', 'cancelled', 'expired'] }).notNull(),
    matchId: uuid('match_id'),
    expiresAt: tsz('expires_at').notNull(),
    createdAt: tsz('created_at').notNull().defaultNow(),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('challenges_not_self', sql`${t.toUser} <> ${t.fromUser}`),
    check('challenges_status', sql`${t.status} in ('pending','accepted','rejected','cancelled','expired')`),
    uniqueIndex('challenges_one_pending_per_pair')
      .on(t.fromUser, t.toUser)
      .where(sql`${t.status} = 'pending'`),
    index('challenges_pending_to_idx')
      .on(t.toUser)
      .where(sql`${t.status} = 'pending'`),
    index('challenges_pending_from_idx')
      .on(t.fromUser)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey(),
    mode: text('mode', { enum: ['friendly', 'ranked'] })
      .notNull()
      .default('friendly'),
    status: text('status', {
      enum: ['created', 'in_progress', 'deciding', 'completed', 'aborted'],
    }).notNull(),
    problemId: uuid('problem_id'),
    /** For the battle page (the public problem view is by slug). */
    problemSlug: text('problem_slug'),
    startedAt: tsz('started_at'),
    endsAt: tsz('ends_at'),
    decideDeadline: tsz('decide_deadline'),
    endedAt: tsz('ended_at'),
    winnerId: uuid('winner_id'),
    endReason: text('end_reason', { enum: ['solved', 'forfeit', 'timeout', 'aborted', 'legacy'] }),
    version: integer('version').notNull().default(0),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('matches_mode', sql`${t.mode} in ('friendly','ranked')`),
    check('matches_status', sql`${t.status} in ('created','in_progress','deciding','completed','aborted')`),
    check(
      'matches_end_reason',
      sql`${t.endReason} is null or ${t.endReason} in ('solved','forfeit','timeout','aborted','legacy')`,
    ),
    index('matches_open_by_deadline')
      .on(t.endsAt)
      .where(sql`${t.status} in ('in_progress','deciding')`),
    index('matches_stuck_created')
      .on(t.createdAt)
      .where(sql`${t.status} = 'created'`),
  ],
);

export const matchParticipants = pgTable(
  'match_participants',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    userId: uuid('user_id').notNull(),
    result: text('result', { enum: ['win', 'loss', 'draw'] }),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.userId] }),
    check('match_participants_result', sql`${t.result} is null or ${t.result} in ('win','loss','draw')`),
    // history: uuidv7 match ids are time-ordered
    index('match_participants_user_idx').on(t.userId, t.matchId.desc()),
  ],
);

/** THE "one active match per user" invariant: a PK conflict means the user is busy. */
export const userActiveMatch = pgTable('user_active_match', {
  userId: uuid('user_id').primaryKey(),
  matchId: uuid('match_id')
    .notNull()
    .references(() => matches.id),
});

/** Read model from judge events: the winner rule needs submit times and verdicts. */
export const matchSubmissions = pgTable(
  'match_submissions',
  {
    submissionId: uuid('submission_id').primaryKey(),
    matchId: uuid('match_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** Judge intake's server time: the fairness key. */
    submittedAt: tsz('submitted_at').notNull(),
    /** null = still judging. */
    verdict: text('verdict'),
    judgedAt: tsz('judged_at'),
  },
  (t) => [index('match_submissions_match_idx').on(t.matchId, t.submittedAt)],
);

export type ChallengeRow = typeof challenges.$inferSelect;
export type MatchRow = typeof matches.$inferSelect;
export type MatchSubmissionRow = typeof matchSubmissions.$inferSelect;
