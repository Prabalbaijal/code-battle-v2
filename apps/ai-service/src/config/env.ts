import { MIN_INTERNAL_SECRET_LENGTH } from '@cb/auth';
import { AI_FEATURES } from '@cb/contracts';
import { baseEnvSchema, envBool, envList, envOptional, loadEnv } from '@cb/env';
import { z } from 'zod';

const positive = (def: number) => z.coerce.number().int().positive().default(def);

export const envSchema = baseEnvSchema
  .extend({
    SERVICE_NAME: z.string().default('ai-service'),
    PORT: z.coerce.number().int().positive().default(4008),
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: envList,
    KAFKA_SSL: envBool(false),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),
    JWKS_URL: z.string().url().default('http://localhost:4001/.well-known/jwks.json'),
    INTERNAL_SERVICE_SECRET: z.string().min(MIN_INTERNAL_SECRET_LENGTH),
    CSRF_REQUIRED: envBool(true),
    /** Code of submissions (judge), statements (problem), coins for hints (rating). */
    JUDGE_SERVICE_URL: z.string().url().default('http://localhost:4005'),
    PROBLEM_SERVICE_URL: z.string().url().default('http://localhost:4004'),
    RATING_SERVICE_URL: z.string().url().default('http://localhost:4007'),

    // ---- the model provider (plan §22.3 ModelGateway) ----
    /** groq: the hosted API (free tier); fake: scripted answers for tests; none: AI switched off. */
    AI_PROVIDER: z.enum(['groq', 'fake', 'none']).default('groq'),
    GROQ_API_KEY: envOptional,
    GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
    /** Cheap and fast: the coach, the hint leak guard. */
    AI_MODEL_FAST: z.string().default('openai/gpt-oss-20b'),
    /** Stronger: hints and the tutor. */
    AI_MODEL_STRONG: z.string().default('openai/gpt-oss-120b'),
    /** Which features are on (all by default). */
    AI_FEATURES: z
      .string()
      .optional()
      .transform((v) =>
        v
          ? v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [...AI_FEATURES],
      )
      .pipe(z.array(z.enum(AI_FEATURES))),

    // ---- budgets (plan §22.4). Defaults sit under Groq's free tier: 200K tokens and 1K requests
    // per model per day (UTC), so a busy day stops cleanly instead of hitting the provider's 429s.
    AI_DAILY_TOKENS_PER_MODEL: positive(180_000),
    AI_DAILY_REQUESTS_PER_MODEL: positive(900),
    /** Per player per day, across features. */
    AI_USER_DAILY_TOKENS: positive(30_000),
    /** Hints in a battle cost coins: level 1, 2, 3 (paid through rating-service's ledger). */
    HINT_COSTS: z
      .string()
      .optional()
      .transform((v) => (v ?? '10,20,30').split(',').map((s) => Number(s.trim())))
      .pipe(z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)])),

    // ---- the tutor's retrieval (plan §22.2 #3) ----
    /** local: a small embedding model on the CPU (free); hash: deterministic stand-in for tests. */
    EMBEDDINGS: z.enum(['local', 'hash']).default('local'),
    EMBEDDING_MODEL: z.string().default('Xenova/bge-small-en-v1.5'),
    /** Where the downloaded embedding model is cached. */
    MODEL_CACHE_DIR: envOptional,
  })
  .transform((e) => ({
    ...e,
    // no key → no provider: everything degrades to "AI unavailable" instead of failing at boot
    AI_PROVIDER: e.AI_PROVIDER === 'groq' && !e.GROQ_API_KEY ? ('none' as const) : e.AI_PROVIDER,
  }));

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
