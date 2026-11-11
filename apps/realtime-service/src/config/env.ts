import { MIN_INTERNAL_SECRET_LENGTH } from '@cb/auth';
import { baseEnvSchema, envBool, envList, loadEnv } from '@cb/env';
import { hostname } from 'node:os';
import { z } from 'zod';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('realtime-service'),
  PORT: z.coerce.number().int().positive().default(4010),
  /** Presence only (plan §13.3); delivery doesn't depend on it. */
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: envList,
  KAFKA_SSL: envBool(false),
  KAFKA_SASL_USERNAME: z.string().optional(),
  KAFKA_SASL_PASSWORD: z.string().optional(),
  JWKS_URL: z.string().url().default('http://localhost:4001/.well-known/jwks.json'),
  INTERNAL_SERVICE_SECRET: z.string().min(MIN_INTERNAL_SECRET_LENGTH),
  USER_SERVICE_URL: z.string().url().default('http://localhost:4002'),
  /** Origins allowed to open a socket. In production it's the site itself, behind Caddy. */
  CORS_ORIGINS: envList.default(['http://localhost:3000']),
  CSRF_REQUIRED: envBool(true),
  /** Each node reads every event with its own consumer group (plan §13.2). */
  NODE_ID: z.string().default(`${hostname()}-${process.pid}`),
  PRESENCE_OFFLINE_DEBOUNCE_MS: z.coerce.number().int().min(0).default(5000),
  MAX_CONNECTIONS_PER_USER: z.coerce.number().int().min(1).default(5),
});

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
