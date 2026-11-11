import { MIN_INTERNAL_SECRET_LENGTH } from '@cb/auth';
import { baseEnvSchema, envBool, envList, loadEnv } from '@cb/env';
import { z } from 'zod';

export const envSchema = baseEnvSchema
  .extend({
    SERVICE_NAME: z.string().default('notification-service'),
    PORT: z.coerce.number().int().positive().default(4003),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    KAFKA_BROKERS: envList,
    KAFKA_SSL: envBool(false),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),
    JWKS_URL: z.string().url().default('http://localhost:4001/.well-known/jwks.json'),
    CSRF_REQUIRED: envBool(true),
    /** In-app notifications look up names (friend requests, match results) in user-service. */
    INTERNAL_SERVICE_SECRET: z.string().min(MIN_INTERNAL_SECRET_LENGTH),
    USER_SERVICE_URL: z.string().url().default('http://localhost:4002'),
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
