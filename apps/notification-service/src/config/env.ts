import { baseEnvSchema, loadEnv } from '@cb/env';
import { z } from 'zod';

export const envSchema = baseEnvSchema
  .extend({
    SERVICE_NAME: z.string().default('notification-service'),
    PORT: z.coerce.number().int().positive().default(4003),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    /** `fake` stores mail in the `fake_inbox` table (dev, tests, E2E). `brevo` sends for real. */
    EMAIL_PROVIDER: z.enum(['fake', 'brevo']).default('fake'),
    BREVO_API_KEY: z.string().min(1).optional(),
    BREVO_API_URL: z.string().url().default('https://api.brevo.com/v3'),
    /** Sender address; must be a verified sender (or domain) in Brevo. */
    EMAIL_FROM: z.email().default('no-reply@codebattle.local'),
    EMAIL_FROM_NAME: z.string().min(1).default('Code Battle'),
    /** Stay under the provider's free daily quota (Brevo free: 300/day shared). */
    EMAIL_DAILY_CAP: z.coerce.number().int().positive().default(280),
    /** Provider calls per second across this worker. */
    EMAIL_RATE_PER_SEC: z.coerce.number().int().positive().default(5),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_PROVIDER === 'brevo' && !env.BREVO_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['BREVO_API_KEY'],
        message: 'required when EMAIL_PROVIDER=brevo',
      });
    }
    if (env.NODE_ENV === 'production' && env.EMAIL_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message: 'fake provider is not allowed in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
