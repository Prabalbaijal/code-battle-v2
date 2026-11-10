import { MIN_INTERNAL_SECRET_LENGTH } from '@cb/auth';
import { baseEnvSchema, envBool, envList, loadEnv } from '@cb/env';
import { z } from 'zod';

export const envSchema = baseEnvSchema
  .extend({
    SERVICE_NAME: z.string().default('problem-service'),
    PORT: z.coerce.number().int().positive().default(4004),
    DATABASE_URL: z.string().url(),
    /** BullMQ (problem-calibrate jobs). */
    REDIS_URL: z.string().url(),
    JUDGE_SERVICE_URL: z.string().url().default('http://localhost:4005'),
    KAFKA_BROKERS: envList,
    KAFKA_SSL: envBool(false),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),
    JWKS_URL: z.string().url().default('http://localhost:4001/.well-known/jwks.json'),
    /** Required: judge-spec, blobs and selections are internal routes. */
    INTERNAL_SERVICE_SECRET: z.string().min(MIN_INTERNAL_SECRET_LENGTH),
    /** How other services reach this one (blob URLs in judge specs). */
    SELF_URL: z.string().url().default('http://localhost:4004'),
    CSRF_REQUIRED: envBool(true),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.SELF_URL.includes('localhost')) {
      ctx.addIssue({
        code: 'custom',
        path: ['SELF_URL'],
        message: 'must be the internal service URL in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
