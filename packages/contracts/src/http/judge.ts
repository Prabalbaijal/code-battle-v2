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

export const languageInfoSchema = z.object({
  key: languageKeySchema,
  name: z.string(),
  enabled: z.boolean(),
});

/** GET /internal/capacity: battle-service admission control (plan §14.6). */
export const capacitySchema = z.object({
  day: z.string(),
  used: z.number(),
  limit: z.number(),
  remaining: z.number(),
  breaker: z.enum(['closed', 'open', 'half_open']),
});
export type Capacity = z.infer<typeof capacitySchema>;

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
