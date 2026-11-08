import { baseEnvSchema, envBool, envList, loadEnv } from '@cb/env';
import { z } from 'zod';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('template-service'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: envList,
  KAFKA_SSL: envBool(false),
  KAFKA_SASL_USERNAME: z.string().optional(),
  KAFKA_SASL_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
