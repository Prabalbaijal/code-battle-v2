import { z } from 'zod';
import { verdictSchema } from './judge.js';
import { languageKeySchema } from './problems.js';

/**
 * ai-service (plan §22): post-match coach, progressive hints, RAG tutor, recommendations and
 * anti-cheat flags. AI is never on the critical path of a match: judging and winners don't use it.
 */

export const AI_FEATURES = ['review', 'hints', 'tutor', 'recommendations', 'integrity'] as const;
export const aiFeatureSchema = z.enum(AI_FEATURES);
export type AiFeature = z.infer<typeof aiFeatureSchema>;

/** GET /api/v1/ai/status: what the UI may offer right now (public). */
export const aiStatusSchema = z.object({
  enabled: z.boolean(),
  features: z.record(aiFeatureSchema, z.boolean()),
  /** Coins per hint level in a battle (level 1, 2, 3). */
  hintCosts: z.tuple([z.number(), z.number(), z.number()]),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;

// ---------------- post-match coach ----------------

/** What the model returns (strict JSON schema on the provider side, validated again here). */
export const aiReviewContentSchema = z.object({
  summary: z.string(),
  /** Why the final verdict happened, in plain words ("int overflowed on case 4"). */
  verdictExplanation: z.string(),
  complexity: z.object({ time: z.string(), space: z.string() }),
  issues: z.array(z.object({ title: z.string(), detail: z.string() })).max(5),
  betterApproach: z.string(),
  /** How the opponent's approach differed; empty when there's nothing to compare. */
  comparison: z.string(),
  tips: z.array(z.string()).max(3),
});
export type AiReviewContent = z.infer<typeof aiReviewContentSchema>;

export const aiReviewSchema = z.object({
  matchId: z.uuid(),
  status: z.enum(['pending', 'ready', 'failed']),
  review: aiReviewContentSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AiReview = z.infer<typeof aiReviewSchema>;

// ---------------- hints ----------------

export const hintRequestSchema = z.object({
  problemId: z.uuid(),
  level: z.number().int().min(1).max(3),
  /** Set in a battle: the hint costs coins (idempotent per match and level). */
  matchId: z.uuid().optional(),
  /** The player's current code, to aim the hint (never shown to anyone else). */
  code: z.string().max(16_000).optional(),
  languageKey: languageKeySchema.optional(),
});
export type HintRequest = z.infer<typeof hintRequestSchema>;

export const hintSchema = z.object({
  problemId: z.uuid(),
  level: z.number(),
  text: z.string(),
  /** Coins taken for this hint now (0 when free or already paid). */
  charged: z.number(),
  /** Balance after a charge; null when nothing was charged. */
  coins: z.number().nullable(),
});
export type Hint = z.infer<typeof hintSchema>;

export const hintListSchema = z.object({ items: z.array(hintSchema) });

// ---------------- tutor (server-sent events) ----------------

export const tutorRequestSchema = z.object({
  question: z.string().trim().min(3).max(2000),
  /** "Why did this fail?": one of the asker's own judged submissions (not during its match). */
  submissionId: z.uuid().optional(),
  /** The last few turns, for follow-up questions. */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
    .max(6)
    .default([]),
});
export type TutorRequest = z.infer<typeof tutorRequestSchema>;

export const citationSchema = z.object({
  n: z.number(),
  title: z.string(),
  /** 'note' (a DSA note in this app) or 'problem' (a problem statement). */
  kind: z.enum(['note', 'problem']),
  /** App-relative link (e.g. /learn/prefix-sums#idea). */
  href: z.string().nullable(),
});
export type Citation = z.infer<typeof citationSchema>;

/** SSE frames on POST /api/v1/ai/tutor, one JSON object per `data:` line. */
export const tutorFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('citations'), items: z.array(citationSchema) }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type TutorFrame = z.infer<typeof tutorFrameSchema>;

// ---------------- learn: DSA notes (the tutor's corpus) ----------------

export const noteSummarySchema = z.object({ slug: z.string(), title: z.string(), tags: z.array(z.string()) });
export type NoteSummary = z.infer<typeof noteSummarySchema>;
export const noteSchema = noteSummarySchema.extend({ markdown: z.string() });
export type Note = z.infer<typeof noteSchema>;

// ---------------- recommendations ----------------

export const topicStatSchema = z.object({
  tag: z.string(),
  attempts: z.number(),
  solved: z.number(),
  failed: z.number(),
  /** Most frequent failing verdict on this topic (WA, TLE, ...). */
  commonVerdict: verdictSchema.nullable(),
  notes: z.array(noteSummarySchema),
});
export type TopicStat = z.infer<typeof topicStatSchema>;

export const recommendationsSchema = z.object({
  /** 'history' when there's enough of your own data, else a starter path. */
  basis: z.enum(['history', 'starter']),
  weak: z.array(topicStatSchema),
  strong: z.array(z.string()),
});
export type Recommendations = z.infer<typeof recommendationsSchema>;

// ---------------- admin: anti-cheat flags and AI usage ----------------

export const integrityFlagSchema = z.object({
  id: z.uuid(),
  matchId: z.uuid(),
  problemId: z.uuid(),
  userId: z.uuid(),
  /** The other side of the match, or the author of an earlier similar submission. */
  otherUserId: z.uuid(),
  relation: z.enum(['opponent', 'earlier_submission']),
  /** Winnowing fingerprint similarity, 0..1. */
  similarity: z.number(),
  status: z.enum(['open', 'cleared', 'confirmed']),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type IntegrityFlag = z.infer<typeof integrityFlagSchema>;
export const integrityFlagPageSchema = z.object({ items: z.array(integrityFlagSchema) });
export const integrityReviewSchema = z.object({
  status: z.enum(['cleared', 'confirmed']),
  note: z.string().max(500).optional(),
});

export const aiUsageSchema = z.object({
  day: z.string(),
  models: z.array(
    z.object({
      model: z.string(),
      tokensUsed: z.number(),
      tokensLimit: z.number(),
      requestsUsed: z.number(),
      requestsLimit: z.number(),
    }),
  ),
  byFeature: z.array(z.object({ feature: z.string(), requests: z.number(), tokens: z.number() })),
});
export type AiUsage = z.infer<typeof aiUsageSchema>;
