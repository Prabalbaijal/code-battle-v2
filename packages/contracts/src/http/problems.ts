import { z } from 'zod';
import {
  CHECKER_TYPES,
  DIFFICULTIES,
  LANGUAGE_KEYS,
  MAX_CODE_BYTES,
  PACK_KINDS,
  PROBLEM_LIMITS as L,
  REFERENCE_VERDICTS,
  SLUG_RE,
} from '../constants.js';
import { pageSchema } from './common.js';

export {
  CHECKER_TYPES,
  DIFFICULTIES,
  LANGUAGE_KEYS,
  LANGUAGE_STARTUP_MS,
  LANGUAGE_TIME_FACTORS,
  MAX_CODE_BYTES,
  PACK_KINDS,
  PROBLEM_LIMITS,
  REFERENCE_VERDICTS,
  SLUG_RE,
} from '../constants.js';
export type { CheckerType, Difficulty, LanguageKey, PackKind, ReferenceVerdict } from '../constants.js';

export const languageKeySchema = z.enum(LANGUAGE_KEYS);
export const difficultySchema = z.enum(DIFFICULTIES);
export const checkerTypeSchema = z.enum(CHECKER_TYPES);
export const packKindSchema = z.enum(PACK_KINDS);
export const referenceVerdictSchema = z.enum(REFERENCE_VERDICTS);
export const problemStatusSchema = z.enum(['draft', 'published', 'archived']);

export const exampleSchema = z.object({
  input: z.string().max(L.examples.text),
  output: z.string().max(L.examples.text),
  explanation: z.string().max(L.examples.explanation).optional(),
});

/** Judge0's documented maximums (plan §14.1); the judge re-checks against /config_info at boot. */
export const JUDGE_MAX_MEMORY_KB = L.memoryKb.max;
export const JUDGE_MAX_OUTPUT_KB = L.outputKb.max;

const problemFields = {
  slug: z.string().trim().min(L.slug.min).max(L.slug.max).regex(SLUG_RE, 'lowercase words joined by hyphens'),
  title: z.string().trim().min(L.title.min).max(L.title.max),
  statementMd: z.string().trim().min(1).max(L.statementMd),
  inputFormatMd: z.string().trim().min(1).max(L.formatMd),
  outputFormatMd: z.string().trim().min(1).max(L.formatMd),
  constraints: z
    .array(z.string().trim().min(1).max(L.constraints.length))
    .max(L.constraints.count)
    .default([]),
  examples: z.array(exampleSchema).min(L.examples.min).max(L.examples.max),
  difficulty: difficultySchema,
  tags: z.array(z.string().trim().toLowerCase().min(1).max(L.tags.length)).max(L.tags.count).default([]),
  memoryLimitKb: z.number().int().min(L.memoryKb.min).max(L.memoryKb.max).default(L.memoryKb.default),
  outputLimitKb: z.number().int().min(L.outputKb.min).max(L.outputKb.max).default(L.outputKb.default),
  checkerType: checkerTypeSchema.default('tokens'),
  floatEps: z.number().positive().max(1).nullable().default(null),
};

export const createProblemBodySchema = z
  .object(problemFields)
  .refine((p) => p.checkerType !== 'float' || p.floatEps !== null, {
    path: ['floatEps'],
    message: 'float checker needs floatEps',
  });
export type CreateProblemBody = z.infer<typeof createProblemBodySchema>;

/** Every field optional; `slug` can't change after creation (URLs, caches). */
export const updateProblemBodySchema = z
  .object(problemFields)
  .omit({ slug: true })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'nothing to update');
export type UpdateProblemBody = z.infer<typeof updateProblemBodySchema>;

/** One packed test file (plan §14.2). Inputs are sent as text; ≤ 2 MB each. */
export const putTestFileBodySchema = z.object({
  kind: packKindSchema,
  input: z.string().min(1),
  output: z.string(),
  outputCaseLineCounts: z.array(z.number().int().positive()).nullable().default(null),
});
export type PutTestFileBody = z.infer<typeof putTestFileBodySchema>;

export const referenceSolutionBodySchema = z.object({
  languageKey: languageKeySchema,
  expectedVerdict: referenceVerdictSchema,
  code: z
    .string()
    .min(1)
    .refine(
      (c) => Buffer.byteLength(c, 'utf8') <= MAX_CODE_BYTES,
      `code is larger than ${MAX_CODE_BYTES} bytes`,
    ),
});
export type ReferenceSolutionBody = z.infer<typeof referenceSolutionBodySchema>;

/** Public view: never contains hidden tests (plan §8.5). */
export const publicProblemSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  statementMd: z.string(),
  inputFormatMd: z.string(),
  outputFormatMd: z.string(),
  constraints: z.array(z.string()),
  examples: z.array(exampleSchema),
  difficulty: difficultySchema,
  tags: z.array(z.string()),
  memoryLimitKb: z.number(),
  /** Largest calibrated CPU limit per language (what the statement shows). */
  timeLimitsMs: z.partialRecord(languageKeySchema, z.number()),
  version: z.number(),
});
export type PublicProblem = z.infer<typeof publicProblemSchema>;

export const testFileInfoSchema = z.object({
  ordinal: z.number(),
  kind: packKindSchema,
  caseCount: z.number(),
  inputBytes: z.number(),
  outputCaseLineCounts: z.array(z.number()).nullable(),
  sha256: z.string(),
});

/** Why a problem can't be published yet (all reasons at once, for the admin UI checklist). */
export const publishBlockerSchema = z.object({ code: z.string(), message: z.string() });
export type PublishBlocker = z.infer<typeof publishBlockerSchema>;

/** Latest calibration of a problem (admin view). */
export const calibrationReportSchema = z.object({
  id: z.uuid(),
  version: z.number(),
  status: z.enum(['pending', 'running', 'passed', 'failed']),
  /** Per reference solution and file: verdict and CPU time. */
  runs: z.array(
    z.object({
      referenceId: z.uuid(),
      languageKey: languageKeySchema,
      expectedVerdict: referenceVerdictSchema,
      ordinal: z.number(),
      verdict: z.string().nullable(),
      cpuMs: z.number().nullable(),
    }),
  ),
  limits: z.array(z.object({ ordinal: z.number(), languageKey: languageKeySchema, cpuLimitMs: z.number() })),
  problems: z.array(z.object({ code: z.string(), message: z.string() })),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type CalibrationReport = z.infer<typeof calibrationReportSchema>;

export const adminProblemSchema = publicProblemSchema.extend({
  status: problemStatusSchema,
  checkerType: checkerTypeSchema,
  floatEps: z.number().nullable(),
  outputLimitKb: z.number(),
  calibratedAt: z.iso.datetime().nullable(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  testFiles: z.array(testFileInfoSchema),
  referenceSolutions: z.array(
    z.object({
      id: z.uuid(),
      languageKey: languageKeySchema,
      expectedVerdict: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
  limits: z.array(z.object({ ordinal: z.number(), languageKey: languageKeySchema, cpuLimitMs: z.number() })),
  calibration: calibrationReportSchema.nullable(),
  /** Empty when the problem can be published now (same rules the publish endpoint enforces). */
  publishBlockers: z.array(publishBlockerSchema),
});
export type AdminProblem = z.infer<typeof adminProblemSchema>;

export const adminProblemSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  difficulty: difficultySchema,
  status: problemStatusSchema,
  version: z.number(),
  updatedAt: z.iso.datetime(),
});
export const adminProblemPageSchema = pageSchema(adminProblemSummarySchema);

// ---- internal (service-to-service) ----

export const selectionBodySchema = z.object({
  matchId: z.uuid(),
  userIds: z.array(z.uuid()).min(1).max(2),
  difficulty: difficultySchema.optional(),
});
export const selectionResultSchema = z.object({ matchId: z.uuid(), problemId: z.uuid(), slug: z.string() });
export type SelectionResult = z.infer<typeof selectionResultSchema>;

/** What the judge needs to run a problem (plan §8.5). URLs are fetched with the service token. */
export const judgeSpecSchema = z.object({
  problemId: z.uuid(),
  version: z.number(),
  status: problemStatusSchema,
  checker: z.object({ type: checkerTypeSchema, eps: z.number().nullable() }),
  memoryLimitKb: z.number(),
  outputLimitKb: z.number(),
  files: z.array(
    z.object({
      ordinal: z.number(),
      kind: packKindSchema,
      caseCount: z.number(),
      outputCaseLineCounts: z.array(z.number()).nullable(),
      sha256: z.string(),
      inputUrl: z.string(),
      outputUrl: z.string(),
      cpuLimitMs: z.partialRecord(languageKeySchema, z.number()),
    }),
  ),
});
export type JudgeSpec = z.infer<typeof judgeSpecSchema>;
