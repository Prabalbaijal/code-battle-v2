import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Infra tables every service owns (outbox, inbox, dead letters, job outbox, idempotency keys).
export { deadLetters, outbox, processedEvents } from '@cb/events';
export { idempotencyKeys } from '@cb/idempotency';
export { jobOutbox } from '@cb/queue';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export interface Example {
  input: string;
  output: string;
  explanation?: string;
}

/** Plan §9.3. `version` moves on any test/limit change (verdict caches and rejudges key on it). */
export const problems = pgTable(
  'problems',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull().unique('problems_slug_key'),
    title: text('title').notNull(),
    statementMd: text('statement_md').notNull(),
    inputFormatMd: text('input_format_md').notNull(),
    outputFormatMd: text('output_format_md').notNull(),
    constraints: text('constraints')
      .array()
      .notNull()
      .default(sql`'{}'`),
    examples: jsonb('examples')
      .$type<Example[]>()
      .notNull()
      .default(sql`'[]'`),
    difficulty: text('difficulty', { enum: ['Easy', 'Medium', 'Hard'] }).notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    status: text('status', { enum: ['draft', 'published', 'archived'] })
      .notNull()
      .default('draft'),
    version: integer('version').notNull().default(1),
    memoryLimitKb: integer('memory_limit_kb').notNull().default(196608),
    outputLimitKb: integer('output_limit_kb').notNull().default(1024),
    checkerType: text('checker_type', { enum: ['tokens', 'float', 'exact'] })
      .notNull()
      .default('tokens'),
    floatEps: doublePrecision('float_eps'),
    randomKey: doublePrecision('random_key')
      .notNull()
      .default(sql`random()`),
    calibratedAt: timestamp('calibrated_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    legacyMongoId: text('legacy_mongo_id').unique('problems_legacy_mongo_id_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('problems_difficulty', sql`${t.difficulty} in ('Easy','Medium','Hard')`),
    check('problems_status', sql`${t.status} in ('draft','published','archived')`),
    check('problems_checker', sql`${t.checkerType} in ('tokens','float','exact')`),
    index('problems_published_random')
      .on(t.randomKey)
      .where(sql`${t.status} = 'published'`),
    index('problems_published_difficulty')
      .on(t.difficulty, t.randomKey)
      .where(sql`${t.status} = 'published'`),
    index('problems_tags').using('gin', t.tags),
  ],
);

/** Few packed files per problem (plan §14.2). Contents live in `blobs`, addressed by sha256. */
export const testFiles = pgTable(
  'test_files',
  {
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id),
    ordinal: smallint('ordinal').notNull(),
    kind: text('kind', { enum: ['sample', 'small', 'large'] }).notNull(),
    caseCount: integer('case_count').notNull(),
    inputUri: text('input_uri').notNull(),
    outputUri: text('output_uri').notNull(),
    outputCaseLineCounts: integer('output_case_line_counts').array(),
    inputBytes: integer('input_bytes').notNull(),
    sha256: text('sha256').notNull(),
  },
  (t) => [
    primaryKey({ name: 'test_files_pkey', columns: [t.problemId, t.ordinal] }),
    check('test_files_kind', sql`${t.kind} in ('sample','small','large')`),
    check('test_files_input_bytes', sql`${t.inputBytes} <= 2097152`),
    check('test_files_ordinal', sql`${t.ordinal} between 1 and 4`),
  ],
);

/** Calibrated CPU limit per (problem, file, language) (plan §14.7). */
export const problemLanguageLimits = pgTable(
  'problem_language_limits',
  {
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id),
    ordinal: smallint('ordinal').notNull(),
    languageKey: text('language_key').notNull(),
    cpuLimitMs: integer('cpu_limit_ms').notNull(),
  },
  (t) => [
    primaryKey({ name: 'problem_language_limits_pkey', columns: [t.problemId, t.ordinal, t.languageKey] }),
  ],
);

export const referenceSolutions = pgTable(
  'reference_solutions',
  {
    id: uuid('id').primaryKey(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id),
    languageKey: text('language_key').notNull(),
    expectedVerdict: text('expected_verdict', { enum: ['AC', 'TLE', 'WA'] }).notNull(),
    codeUri: text('code_uri').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reference_solutions_problem_idx').on(t.problemId),
    check('reference_solutions_verdict', sql`${t.expectedVerdict} in ('AC','TLE','WA')`),
  ],
);

export const calibrationRuns = pgTable('calibration_runs', {
  id: uuid('id').primaryKey(),
  solutionId: uuid('solution_id')
    .notNull()
    .references(() => referenceSolutions.id),
  ordinal: smallint('ordinal').notNull(),
  cpuMs: integer('cpu_ms'),
  verdict: text('verdict'),
  driftFactor: numeric('drift_factor', { precision: 4, scale: 2 }).notNull().default('1.00'),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One calibration attempt of a problem version (plan §14.7): its runs, limits and problems. */
export const calibrations = pgTable(
  'calibrations',
  {
    id: uuid('id').primaryKey(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id),
    version: integer('version').notNull(),
    status: text('status', { enum: ['pending', 'running', 'passed', 'failed'] }).notNull(),
    runs: jsonb('runs')
      .$type<CalibrationRunJson[]>()
      .notNull()
      .default(sql`'[]'`),
    limits: jsonb('limits')
      .$type<{ ordinal: number; languageKey: string; cpuLimitMs: number }[]>()
      .notNull()
      .default(sql`'[]'`),
    problems: jsonb('problems')
      .$type<{ code: string; message: string }[]>()
      .notNull()
      .default(sql`'[]'`),
    requestedBy: uuid('requested_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('calibrations_problem_idx').on(t.problemId, t.createdAt),
    check('calibrations_status', sql`${t.status} in ('pending','running','passed','failed')`),
  ],
);

export interface CalibrationRunJson {
  referenceId: string;
  languageKey: string;
  expectedVerdict: 'AC' | 'TLE' | 'WA';
  ordinal: number;
  verdict: string | null;
  cpuMs: number | null;
}

export const userProblemSeen = pgTable(
  'user_problem_seen',
  {
    userId: uuid('user_id').notNull(),
    problemId: uuid('problem_id').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'user_problem_seen_pkey', columns: [t.userId, t.problemId] })],
);

/** Idempotent selection: one problem per match, ever. */
export const matchProblem = pgTable('match_problem', {
  matchId: uuid('match_id').primaryKey(),
  problemId: uuid('problem_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Content-addressed blob store (key = "sha256/<hex>"). Test packs and reference code live here
 * instead of R2 for the ₹0 target; `BlobStore` keeps an object-store adapter possible later.
 */
export const blobs = pgTable('blobs', {
  key: text('key').primaryKey(),
  bytes: bytea('bytes').notNull(),
  size: integer('size').notNull(),
  contentType: text('content_type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ProblemRow = typeof problems.$inferSelect;
export type TestFileRow = typeof testFiles.$inferSelect;
export type ReferenceSolutionRow = typeof referenceSolutions.$inferSelect;
export type LimitRow = typeof problemLanguageLimits.$inferSelect;
export type CalibrationRow = typeof calibrations.$inferSelect;
