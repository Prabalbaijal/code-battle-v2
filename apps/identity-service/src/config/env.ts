import { baseEnvSchema, envBool, envList, loadEnv } from '@cb/env';
import { z } from 'zod';

export const envSchema = baseEnvSchema
  .extend({
    SERVICE_NAME: z.string().default('identity-service'),
    PORT: z.coerce.number().int().positive().default(4001),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    KAFKA_BROKERS: envList,
    KAFKA_SSL: envBool(false),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),
    /** JSON array of private Ed25519 JWKs; first one signs. `pnpm gen-keys` prints one. */
    JWT_KEYS: z.string().optional(),
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** Links in emails point here (`/verify-email?token=`, `/reset-password?token=`). */
    WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
    /** Returned with socket tickets. */
    REALTIME_URL: z.string().url().default('http://localhost:4010'),
    /** Secure cookies need HTTPS; turn off only for plain-http local dev. */
    COOKIE_SECURE: envBool(true),
    CSRF_REQUIRED: envBool(true),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.JWT_KEYS) {
      ctx.addIssue({ code: 'custom', path: ['JWT_KEYS'], message: 'required in production' });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
