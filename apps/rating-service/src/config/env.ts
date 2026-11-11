import { MIN_INTERNAL_SECRET_LENGTH } from '@cb/auth';
import { baseEnvSchema, envBool, envList, loadEnv } from '@cb/env';
import { z } from 'zod';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('rating-service'),
  PORT: z.coerce.number().int().positive().default(4007),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: envList,
  KAFKA_SSL: envBool(false),
  KAFKA_SASL_USERNAME: z.string().optional(),
  KAFKA_SASL_PASSWORD: z.string().optional(),
  JWKS_URL: z.string().url().default('http://localhost:4001/.well-known/jwks.json'),
  /** Calls user-service for leaderboard profiles and friend lists. */
  INTERNAL_SERVICE_SECRET: z.string().min(MIN_INTERNAL_SECRET_LENGTH),
  USER_SERVICE_URL: z.string().url().default('http://localhost:4002'),
  CSRF_REQUIRED: envBool(true),
  /** Plan §15: the ZSET is rebuilt from Postgres on boot and then daily. */
  LEADERBOARD_REBUILD_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(24 * 60 * 60_000),
});

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
