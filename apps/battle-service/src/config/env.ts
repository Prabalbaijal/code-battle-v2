import { MIN_INTERNAL_SECRET_LENGTH } from '@cb/auth';
import { baseEnvSchema, envBool, envList, loadEnv } from '@cb/env';
import { z } from 'zod';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('battle-service'),
  PORT: z.coerce.number().int().positive().default(4006),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: envList,
  KAFKA_SSL: envBool(false),
  KAFKA_SASL_USERNAME: z.string().optional(),
  KAFKA_SASL_PASSWORD: z.string().optional(),
  JWKS_URL: z.string().url().default('http://localhost:4001/.well-known/jwks.json'),
  /** Calls problem/judge/user internal routes and serves /internal/matches to judge-service. */
  INTERNAL_SERVICE_SECRET: z.string().min(MIN_INTERNAL_SECRET_LENGTH),
  PROBLEM_SERVICE_URL: z.string().url().default('http://localhost:4004'),
  JUDGE_SERVICE_URL: z.string().url().default('http://localhost:4005'),
  USER_SERVICE_URL: z.string().url().default('http://localhost:4002'),
  REALTIME_SERVICE_URL: z.string().url().default('http://localhost:4010'),
  CSRF_REQUIRED: envBool(true),
  /** Plan §23.5. Server time only. */
  MATCH_DURATION_SECONDS: z.coerce.number().int().min(60).default(1800),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(5).default(30),
  DECIDE_CAP_SECONDS: z.coerce.number().int().min(10).default(600),
  RECONCILER_INTERVAL_MS: z.coerce.number().int().min(100).default(15_000),
});

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
