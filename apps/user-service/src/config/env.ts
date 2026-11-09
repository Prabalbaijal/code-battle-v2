import { MIN_INTERNAL_SECRET_LENGTH } from '@cb/auth';
import { baseEnvSchema, envBool, envList, loadEnv } from '@cb/env';
import { z } from 'zod';

export const envSchema = baseEnvSchema
  .extend({
    SERVICE_NAME: z.string().default('user-service'),
    PORT: z.coerce.number().int().positive().default(4002),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    KAFKA_BROKERS: envList,
    KAFKA_SSL: envBool(false),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),
    /** identity-service public keys (access tokens are verified locally). */
    JWKS_URL: z.string().url().default('http://localhost:4001/.well-known/jwks.json'),
    /** Shared secret for `/internal/*` service tokens. Internal routes are off without it. */
    INTERNAL_SERVICE_SECRET: z.string().min(MIN_INTERNAL_SECRET_LENGTH).optional(),
    CSRF_REQUIRED: envBool(true),
    /** Signed direct avatar uploads. Without these, avatar upload is disabled (initials avatar). */
    CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
    CLOUDINARY_API_KEY: z.string().min(1).optional(),
    CLOUDINARY_API_SECRET: z.string().min(1).optional(),
    CLOUDINARY_FOLDER: z
      .string()
      .regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/)
      .default('codebattle/avatars'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.INTERNAL_SERVICE_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['INTERNAL_SERVICE_SECRET'], message: 'required in production' });
    }
    const cloud = [env.CLOUDINARY_CLOUD_NAME, env.CLOUDINARY_API_KEY, env.CLOUDINARY_API_SECRET];
    if (cloud.some(Boolean) && !cloud.every(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLOUDINARY_CLOUD_NAME'],
        message: 'set all of CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET (or none)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
