import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

// Infra tables every service owns (outbox, inbox, dead letters).
export { deadLetters, outbox, processedEvents } from '@cb/events';

const tsz = (name: string) => timestamp(name, { withTimezone: true });
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** Dimension of the local embedding model (bge-small-en-v1.5 / all-MiniLM-L6-v2). */
export const EMBEDDING_DIM = 384;

// ---------------- read models, built from other services' events ----------------

/** From problem.published/updated: what a problem is about (tags feed recommendations). */
export const aiProblems = pgTable('ai_problems', {
  problemId: uuid('problem_id').primaryKey(),
  slug: text('slug').notNull(),
  difficulty: text('difficulty'),
  tags: text('tags')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  version: integer('version').notNull(),
  status: text('status').notNull(),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
});

/** From battle.match.started/completed/aborted: who played what, and whether it's still running. */
export const aiMatches = pgTable(
  'ai_matches',
  {
    matchId: uuid('match_id').primaryKey(),
    problemId: uuid('problem_id').notNull(),
    userIds: uuid('user_ids').array().notNull(),
    status: text('status', { enum: ['in_progress', 'completed', 'aborted'] }).notNull(),
    winnerId: uuid('winner_id'),
    endReason: text('end_reason'),
    startedAt: tsz('started_at').notNull(),
    endsAt: tsz('ends_at'),
    endedAt: tsz('ended_at'),
  },
  (t) => [index('ai_matches_users_idx').using('gin', t.userIds)],
);

/** From judge.submission.judged (Submits only): per-topic history for recommendations. */
export const aiSubmissions = pgTable(
  'ai_submissions',
  {
    submissionId: uuid('submission_id').primaryKey(),
    userId: uuid('user_id').notNull(),
    problemId: uuid('problem_id').notNull(),
    matchId: uuid('match_id'),
    verdict: text('verdict').notNull(),
    judgedAt: tsz('judged_at').notNull(),
  },
  (t) => [index('ai_submissions_user_idx').on(t.userId, t.judgedAt.desc())],
);

// ---------------- budgets and accounting (plan §22.4) ----------------

/** Spend per model per UTC day, reserved before each call and settled after (atomic UPDATE). */
export const aiBudgetDaily = pgTable(
  'ai_budget_daily',
  {
    day: date('day').notNull(),
    model: text('model').notNull(),
    tokensUsed: integer('tokens_used').notNull().default(0),
    requestsUsed: integer('requests_used').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.model] })],
);

/** Tokens per player per UTC day, across features. */
export const aiUserUsage = pgTable(
  'ai_user_usage',
  {
    userId: uuid('user_id').notNull(),
    day: date('day').notNull(),
    tokensUsed: integer('tokens_used').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/** One row per model call: feature, model, prompt version, tokens, latency, outcome. */
export const aiRequests = pgTable(
  'ai_requests',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id'),
    feature: text('feature').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [index('ai_requests_created_idx').on(t.createdAt.desc())],
);

// ---------------- features ----------------

/** Post-match coach: one review per player per match, made by the worker. */
export const aiReviews = pgTable(
  'ai_reviews',
  {
    matchId: uuid('match_id').notNull(),
    userId: uuid('user_id').notNull(),
    status: text('status', { enum: ['pending', 'ready', 'failed'] }).notNull(),
    content: jsonb('content'),
    promptVersion: text('prompt_version'),
    model: text('model'),
    error: text('error'),
    createdAt: tsz('created_at').notNull().defaultNow(),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.userId] })],
);

/** Hints: generated once per player, problem and level, then served from here (plan §22.6). */
export const aiHints = pgTable(
  'ai_hints',
  {
    userId: uuid('user_id').notNull(),
    problemId: uuid('problem_id').notNull(),
    level: smallint('level').notNull(),
    text: text('text').notNull(),
    /** The match it was asked in (a battle hint costs coins); null outside a match. */
    matchId: uuid('match_id'),
    /** Coins taken; false while the charge hasn't gone through (then it isn't shown). */
    paid: boolean('paid').notNull(),
    promptVersion: text('prompt_version').notNull(),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.problemId, t.level] }),
    check('ai_hints_level', sql`${t.level} between 1 and 3`),
  ],
);

/** The tutor's corpus: DSA notes from the repo and published problem statements. */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind', { enum: ['note', 'problem'] }).notNull(),
    /** Note slug or problem id: re-ingesting replaces the document. */
    ref: text('ref').notNull(),
    title: text('title').notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** sha256 of the source text: unchanged documents aren't embedded again. */
    sourceHash: text('source_hash').notNull(),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('documents_ref_key').on(t.kind, t.ref)],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    heading: text('heading').notNull(),
    /** Link target inside the app (e.g. /learn/prefix-sums#idea). */
    anchor: text('anchor'),
    content: text('content').notNull(),
    tsv: tsvector('tsv')
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('english', heading || ' ' || content)`),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
  },
  (t) => [
    index('chunks_tsv_idx').using('gin', t.tsv),
    index('chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/** Anti-cheat signals (plan §22.2 #6): a flag for an admin to review, never an automatic penalty. */
export const integrityFlags = pgTable(
  'integrity_flags',
  {
    id: uuid('id').primaryKey(),
    matchId: uuid('match_id').notNull(),
    problemId: uuid('problem_id').notNull(),
    userId: uuid('user_id').notNull(),
    submissionId: uuid('submission_id').notNull(),
    otherUserId: uuid('other_user_id').notNull(),
    otherSubmissionId: uuid('other_submission_id').notNull(),
    relation: text('relation', { enum: ['opponent', 'earlier_submission'] }).notNull(),
    similarity: doublePrecision('similarity').notNull(),
    status: text('status', { enum: ['open', 'cleared', 'confirmed'] })
      .notNull()
      .default('open'),
    note: text('note'),
    reviewedBy: uuid('reviewed_by'),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('integrity_flags_pair_key').on(t.submissionId, t.otherSubmissionId),
    index('integrity_flags_open_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.status} = 'open'`),
  ],
);

/**
 * Durable background work (reviews, integrity checks, problem ingestion). Postgres is the queue:
 * workers claim with FOR UPDATE SKIP LOCKED, so the AI side needs no Redis at all, and the unique
 * key makes enqueueing idempotent.
 */
export const aiTasks = pgTable(
  'ai_tasks',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind', { enum: ['review', 'integrity', 'ingest_problem'] }).notNull(),
    key: text('key').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: tsz('run_after').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: tsz('created_at').notNull().defaultNow(),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_tasks_key').on(t.kind, t.key),
    index('ai_tasks_due_idx')
      .on(t.runAfter)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export type AiMatchRow = typeof aiMatches.$inferSelect;
export type AiTaskRow = typeof aiTasks.$inferSelect;
export type AiHintRow = typeof aiHints.$inferSelect;
export type IntegrityFlagRow = typeof integrityFlags.$inferSelect;
