import { z } from 'zod';
import { DIFFICULTIES } from '../constants.js';
import { TOPICS, defineEvent } from './envelope.js';

/** problem-service events on `problem.events`, keyed by problemId (plan §10.2). */
export const problemPublishedV1 = defineEvent(
  TOPICS.problem,
  'problem.published.v1',
  z.object({
    problemId: z.uuid(),
    slug: z.string(),
    version: z.number().int(),
    difficulty: z.enum(DIFFICULTIES),
    tags: z.array(z.string()),
  }),
);

/** Any change after creation. `version` moves when tests or limits change (verdict caches key on it). */
export const problemUpdatedV1 = defineEvent(
  TOPICS.problem,
  'problem.updated.v1',
  z.object({
    problemId: z.uuid(),
    slug: z.string(),
    version: z.number().int(),
    status: z.enum(['draft', 'published', 'archived']),
    change: z.enum(['statement', 'tests', 'limits', 'status']),
  }),
);
