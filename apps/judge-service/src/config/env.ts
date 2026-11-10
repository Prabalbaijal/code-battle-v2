import { MIN_INTERNAL_SECRET_LENGTH } from '@cb/auth';
import { baseEnvSchema, envBool, envList, loadEnv } from '@cb/env';
import { z } from 'zod';

export const envSchema = baseEnvSchema
  .extend({
    SERVICE_NAME: z.string().default('judge-service'),
    PORT: z.coerce.number().int().positive().default(4005),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    KAFKA_BROKERS: envList,
    KAFKA_SSL: envBool(false),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),
    JWKS_URL: z.string().url().default('http://localhost:4001/.well-known/jwks.json'),
    INTERNAL_SERVICE_SECRET: z.string().min(MIN_INTERNAL_SECRET_LENGTH),
    PROBLEM_SERVICE_URL: z.string().url().default('http://localhost:4004'),
    CSRF_REQUIRED: envBool(true),

    /** Judge0 API base, e.g. https://judge0-ce.p.rapidapi.com or http://localhost:2358 (fake). */
    JUDGE0_URL: z.string().url().default('http://localhost:2358'),
    /** none (fake / self-hosted), rapidapi (X-RapidAPI-Key), token (X-Auth-Token). */
    JUDGE0_AUTH: z.enum(['none', 'rapidapi', 'token']).default('none'),
    JUDGE0_API_KEY: z.string().optional(),
    /** callback: Judge0 PUTs results to us (needs a public URL); poll: we fetch them. */
    JUDGE0_MODE: z.enum(['callback', 'poll']).default('poll'),
    /** Public base URL Judge0 can reach, e.g. https://api.example.com (callback mode). */
    JUDGE0_CALLBACK_BASE_URL: z.string().url().optional(),
    JUDGE0_CALLBACK_SECRET: z.string().min(32).optional(),
    /** Judge0 submissions per UTC day (plan §14.6). */
    JUDGE0_DAILY_BUDGET: z.coerce.number().int().positive().default(1000),
    /** Calls kept free so matches already running can finish (admission control). */
    MATCH_RESERVE_CALLS: z.coerce.number().int().min(0).default(40),
    /** Per-user, per-match submit cap (plan §14.6). */
    MAX_SUBMITS_PER_MATCH: z.coerce.number().int().positive().default(15),
  })
  .superRefine((env, ctx) => {
    if (env.JUDGE0_AUTH !== 'none' && !env.JUDGE0_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['JUDGE0_API_KEY'],
        message: `required when JUDGE0_AUTH=${env.JUDGE0_AUTH}`,
      });
    }
    if (env.JUDGE0_MODE === 'callback' && (!env.JUDGE0_CALLBACK_BASE_URL || !env.JUDGE0_CALLBACK_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JUDGE0_CALLBACK_BASE_URL'],
        message: 'callback mode needs JUDGE0_CALLBACK_BASE_URL and JUDGE0_CALLBACK_SECRET',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
