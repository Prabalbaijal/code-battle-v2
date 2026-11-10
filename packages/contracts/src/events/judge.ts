import { z } from 'zod';
import { VERDICTS } from '../http/judge.js';
import { TOPICS, defineEvent } from './envelope.js';

/** judge-service events on `judge.events`, keyed by matchId (or submissionId when there's no match). */
const base = {
  submissionId: z.uuid(),
  matchId: z.uuid().nullable(),
  userId: z.uuid(),
  problemId: z.uuid(),
  mode: z.enum(['submit', 'run']),
};

export const submissionCreatedV1 = defineEvent(
  TOPICS.judge,
  'judge.submission.created.v1',
  z.object({ ...base, submittedAt: z.iso.datetime() }),
);

export const submissionProgressV1 = defineEvent(
  TOPICS.judge,
  'judge.submission.progress.v1',
  z.object({ ...base, stage: z.number().int(), status: z.enum(['running', 'delayed']) }),
);

export const submissionJudgedV1 = defineEvent(
  TOPICS.judge,
  'judge.submission.judged.v1',
  z.object({
    ...base,
    verdict: z.enum(VERDICTS),
    failedFile: z.number().int().nullable(),
    failedCase: z.number().int().nullable(),
    maxCpuMs: z.number().int().nullable(),
    maxMemKb: z.number().int().nullable(),
    fromCache: z.boolean(),
    submittedAt: z.iso.datetime(),
    judgedAt: z.iso.datetime(),
  }),
);
