import { aiReviewContentSchema } from '@cb/contracts';
import { z } from 'zod';

/**
 * JSON schemas for strict structured output. Strict mode needs every property in `required` and
 * `additionalProperties: false` on every object; the zod schema checks the answer again on our side.
 */
const str = { type: 'string' } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const reviewSchema = {
  name: 'match_review',
  json: obj({
    summary: str,
    verdictExplanation: str,
    complexity: obj({ time: str, space: str }),
    issues: { type: 'array', items: obj({ title: str, detail: str }) },
    betterApproach: str,
    comparison: str,
    tips: { type: 'array', items: str },
  }),
  // models sometimes give one issue or tip too many: keep the first few instead of failing
  zod: z
    .object({
      summary: z.string(),
      verdictExplanation: z.string(),
      complexity: z.object({ time: z.string(), space: z.string() }),
      issues: z.array(z.object({ title: z.string(), detail: z.string() })),
      betterApproach: z.string(),
      comparison: z.string(),
      tips: z.array(z.string()),
    })
    .transform((r) =>
      aiReviewContentSchema.parse({ ...r, issues: r.issues.slice(0, 5), tips: r.tips.slice(0, 3) }),
    ),
};

export const leakGuardSchema = {
  name: 'leak_guard',
  json: obj({ revealsSolution: { type: 'boolean' }, reason: str }),
  zod: z.object({ revealsSolution: z.boolean(), reason: z.string() }),
};
