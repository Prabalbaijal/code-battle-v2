import { z } from 'zod';
import { MAX_CODE_BYTES } from '../constants.js';
import { languageKeySchema, packKindSchema } from './problems.js';

export const VERDICTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'IE'] as const;
export const verdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof verdictSchema>;
export const submissionModeSchema = z.enum(['submit', 'run']);
export const submissionStatusSchema = z.enum(['queued', 'running', 'done']);

const withinBytes = (max: number) => (s: string) => Buffer.byteLength(s, 'utf8') <= max;

/** POST /api/v1/submissions (plan §8.6). Run = samples (+ optional custom input); Submit = all files. */
export const createSubmissionBodySchema = z
  .object({
    mode: submissionModeSchema,
    problemId: z.uuid(),
    matchId: z.uuid().optional(),
    languageKey: languageKeySchema,
    code: z
      .string()
      .min(1)
      .refine(withinBytes(MAX_CODE_BYTES), `code is larger than ${MAX_CODE_BYTES} bytes`),
    customInput: z
      .string()
      .max(64 * 1024)
      .optional(),
  })
  .refine((b) => b.mode === 'run' || b.customInput === undefined, {
    path: ['customInput'],
    message: 'custom input is only for runs',
  });
export type CreateSubmissionBody = z.infer<typeof createSubmissionBodySchema>;

export const submissionSchema = z.object({
  id: z.uuid(),
  mode: submissionModeSchema,
  problemId: z.uuid(),
  matchId: z.uuid().nullable(),
  languageKey: languageKeySchema,
  status: submissionStatusSchema,
  verdict: verdictSchema.nullable(),
  /** Which pack failed and the 1-based case in it ("Wrong answer on small, case 37"). */
  failedFile: z.object({ ordinal: z.number(), kind: packKindSchema }).nullable(),
  failedCase: z.number().nullable(),
  maxCpuMs: z.number().nullable(),
  maxMemKb: z.number().nullable(),
  /** Trimmed compile output or runtime error text. */
  message: z.string().nullable(),
  fromCache: z.boolean(),
  /** Run mode with custom input: what the program printed. */
  custom: z
    .object({
      stdout: z.string().nullable(),
      stderr: z.string().nullable(),
      verdict: verdictSchema.nullable(),
    })
    .nullable(),
  submittedAt: z.iso.datetime(),
  judgedAt: z.iso.datetime().nullable(),
});
export type SubmissionView = z.infer<typeof submissionSchema>;

/**
 * Internal (service token) view with the source code, for ai-service: the post-match coach, the
 * tutor's "why WA?" and anti-cheat fingerprints (plan §22). Never routed by the gateway.
 */
export const internalSubmissionSchema = submissionSchema.extend({ userId: z.uuid(), code: z.string() });
export type InternalSubmission = z.infer<typeof internalSubmissionSchema>;
export const internalSubmissionQuerySchema = z
  .object({
    matchId: z.uuid().optional(),
    problemId: z.uuid().optional(),
    verdict: verdictSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => q.matchId || q.problemId, 'matchId or problemId is required');

export const languageInfoSchema = z.object({
  key: languageKeySchema,
  name: z.string(),
  enabled: z.boolean(),
});

/** GET /internal/capacity: battle-service admission control (plan §14.6). */
/** The degradation ladder (plan §14.6.6), mildest first. */
export const JUDGE_LEVELS = ['normal', 'no_custom_input', 'runs_throttled', 'no_new_matches'] as const;
export const judgeLevelSchema = z.enum(JUDGE_LEVELS);
export type JudgeLevel = z.infer<typeof judgeLevelSchema>;

/** Today's Judge0 budget, counted in Judge0 requests (a batch of files is one request). */
export const capacitySchema = z.object({
  day: z.string(),
  used: z.number(),
  limit: z.number(),
  remaining: z.number(),
  breaker: z.enum(['closed', 'open', 'half_open']),
  level: judgeLevelSchema,
});
export type Capacity = z.infer<typeof capacitySchema>;

/** Public: what the web shows (a banner when the judge is degraded). No quota numbers. */
export const judgeStatusSchema = z.object({
  level: judgeLevelSchema,
  available: z.boolean(),
});
export type JudgeStatus = z.infer<typeof judgeStatusSchema>;

/** Admin view of the judge (plan §14.6, §14.8). */
export const driftStatusSchema = z.object({
  /** CPU limits are multiplied by this (1 unless the hosted judge drifted more than 20%). */
  factor: z.number(),
  ratio: z.number().nullable(),
  baseline: z.record(z.string(), z.number()).nullable(),
  checks: z.number(),
  lastCheck: z
    .object({
      ranAt: z.iso.datetime(),
      samples: z.record(z.string(), z.number()).nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type DriftStatus = z.infer<typeof driftStatusSchema>;
export const adminJudgeViewSchema = z.object({ capacity: capacitySchema, drift: driftStatusSchema });
export type AdminJudgeView = z.infer<typeof adminJudgeViewSchema>;

// ---- internal: calibration runs (problem-service → judge-service, plan §14.7) ----

/** Run a reference solution on every file (no fail-fast), with a generous CPU limit. */
export const calibrationRequestSchema = z.object({
  problemId: z.uuid(),
  languageKey: languageKeySchema,
  code: z.string().min(1).refine(withinBytes(MAX_CODE_BYTES), 'code too large'),
  /** CPU limit for every file; capped at the Judge0 instance maximum. */
  cpuLimitMs: z.number().int().min(100).max(60_000),
  /** Idempotency: the same key returns the same calibration run. */
  requestKey: z.string().min(1).max(200),
});
export type CalibrationRequest = z.infer<typeof calibrationRequestSchema>;

export const calibrationResultSchema = z.object({
  id: z.uuid(),
  status: submissionStatusSchema,
  problemVersion: z.number(),
  /** The CPU limit actually used (after the instance cap). */
  cpuLimitMs: z.number(),
  files: z.array(
    z.object({
      ordinal: z.number(),
      kind: packKindSchema,
      verdict: verdictSchema.nullable(),
      cpuMs: z.number().nullable(),
      memKb: z.number().nullable(),
      failedCase: z.number().nullable(),
    }),
  ),
});
export type CalibrationResult = z.infer<typeof calibrationResultSchema>;
