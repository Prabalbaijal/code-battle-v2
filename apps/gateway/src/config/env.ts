import { baseEnvSchema, envList, loadEnv } from '@cb/env';
import { z } from 'zod';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('gateway'),
  PORT: z.coerce.number().int().positive().default(8080),
  REDIS_URL: z.string().url(),
  /** identity-service public keys. */
  JWKS_URL: z.string().url().default('http://localhost:4001/.well-known/jwks.json'),
  /** Browser origins allowed for CORS and the Origin check (the web app). */
  CORS_ORIGINS: envList.default(['http://localhost:3000']),
  /**
   * Addresses/CIDRs of proxies allowed to set X-Forwarded-For (e.g. Caddy's Docker network,
   * "172.18.0.0/16", or "loopback" in dev). Empty = trust nobody. Never trust everyone: clients
   * could then spoof their IP and dodge rate limits. (Fastify ignores hop counts for the same reason.)
   */
  TRUSTED_PROXIES: z.string().trim().default(''),
  /** Global per-IP limit (plan §17.2). */
  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(300),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  SERVICE_URL_IDENTITY: z.string().url().default('http://localhost:4001'),
  SERVICE_URL_USER: z.string().url().default('http://localhost:4002'),
  SERVICE_URL_PROBLEM: z.string().url().default('http://localhost:4004'),
  SERVICE_URL_JUDGE: z.string().url().default('http://localhost:4005'),
});

export type Env = z.infer<typeof envSchema>;

export const readEnv = (source: Record<string, string | undefined> = process.env): Env =>
  loadEnv(envSchema, source);
