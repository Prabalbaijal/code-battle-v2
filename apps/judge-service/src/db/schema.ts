import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Infra tables every service owns (outbox, inbox, dead letters, job outbox, idempotency keys).
export { deadLetters, outbox, processedEvents } from '@cb/events';
export { idempotencyKeys } from '@cb/idempotency';
export { jobOutbox } from '@cb/queue';

const VERDICT_SQL = "('AC','WA','TLE','MLE','RE','CE','OLE','IE')";

/** Resolved from Judge0 GET /languages at boot (ids differ between Judge0 versions). */
export const languageProfiles = pgTable('language_profiles', {
  languageKey: text('language_key').primaryKey(),
  judge0LanguageId: integer('judge0_language_id').notNull(),
  name: text('name').notNull(),
  defaultTimeFactor: numeric('default_time_factor', { precision: 3, scale: 1 }).notNull(),
  memOverheadKb: integer('mem_overhead_kb').notNull().default(0),
  maxProcesses: integer('max_processes').notNull().default(1),
  enabled: boolean('enabled').notNull().default(true),
});

/**
 * One row per Submit or Run (plan §9.5). Not partitioned yet (drizzle-kit can't generate
 * partitioned tables); monthly partitioning is a Phase 6 task.
 */
export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    matchId: uuid('match_id'),
    problemId: uuid('problem_id').notNull(),
    problemVersion: integer('problem_version').notNull(),
    mode: text('mode', { enum: ['submit', 'run'] }).notNull(),
    languageKey: text('language_key').notNull(),
    code: text('code').notNull(),
    codeHash: text('code_hash').notNull(),
    customInput: text('custom_input'),
    status: text('status', { enum: ['queued', 'running', 'done'] }).notNull(),
    stage: smallint('stage').notNull().default(0),
    verdict: text('verdict', { enum: ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'IE'] }),
    failedFile: smallint('failed_file'),
    failedKind: text('failed_kind', { enum: ['sample', 'small', 'large'] }),
    failedCase: integer('failed_case'),
    maxCpuMs: integer('max_cpu_ms'),
    maxMemKb: integer('max_mem_kb'),
    message: text('message'),
    fromCache: boolean('from_cache').notNull().default(false),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    judgedAt: timestamp('judged_at', { withTimezone: true }),
  },
  (t) => [
    check('submissions_mode', sql`${t.mode} in ('submit','run')`),
    check('submissions_status', sql`${t.status} in ('queued','running','done')`),
    check('submissions_verdict', sql.raw(`verdict is null or verdict in ${VERDICT_SQL}`)),
    check('submissions_code_size', sql`octet_length(${t.code}) <= 65536`),
    index('submissions_match_idx').on(t.matchId, t.submittedAt),
    index('submissions_user_idx').on(t.userId, t.submittedAt.desc()),
    // verdict cache lookup (plan §14.6)
    index('submissions_cache_idx')
      .on(t.problemId, t.problemVersion, t.codeHash)
      .where(sql`${t.status} = 'done' and ${t.mode} = 'submit'`),
  ],
);

/** One row per Judge0 submission: per test file, per attempt (plan §9.5). File 0 = custom input. */
export const judgeRuns = pgTable(
  'judge_runs',
  {
    id: uuid('id').primaryKey(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id),
    stage: smallint('stage').notNull(),
    fileOrdinal: smallint('file_ordinal').notNull(),
    attempt: smallint('attempt').notNull().default(1),
    judge0Token: text('judge0_token').unique('judge_runs_token_key'),
    status: text('status', { enum: ['pending', 'submitted', 'done', 'failed'] }).notNull(),
    judge0StatusId: smallint('judge0_status_id'),
    cpuMs: integer('cpu_ms'),
    wallMs: integer('wall_ms'),
    memKb: integer('mem_kb'),
    stdoutTrunc: text('stdout_trunc'),
    stderrTrunc: text('stderr_trunc'),
    compileOutput: text('compile_output'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    unique('judge_runs_file_attempt_key').on(t.submissionId, t.fileOrdinal, t.attempt),
    check('judge_runs_status', sql`${t.status} in ('pending','submitted','done','failed')`),
    index('judge_runs_awaiting')
      .on(t.submittedAt)
      .where(sql`${t.status} = 'submitted'`),
    index('judge_runs_submission_idx').on(t.submissionId),
  ],
);

/** Daily Judge0 call budget; Postgres is the source of truth (Redis is never a correctness dependency). */
export const judgeBudgetDaily = pgTable('judge_budget_daily', {
  day: date('day').primaryKey(),
  callsUsed: integer('calls_used').notNull().default(0),
  callsLimit: integer('calls_limit').notNull(),
});

export type SubmissionRow = typeof submissions.$inferSelect;
export type JudgeRunRow = typeof judgeRuns.$inferSelect;
export type LanguageProfileRow = typeof languageProfiles.$inferSelect;
