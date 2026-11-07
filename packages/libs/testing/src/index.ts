import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import pg from 'pg';

/**
 * Create tables for the given drizzle table objects (same SQL drizzle-kit would generate),
 * so library tests never hand-write DDL that can drift from the schema.
 */
export async function createTables(connectionString: string, tables: Record<string, unknown>): Promise<void> {
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(tables));
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const s of statements) await client.query(s);
  } finally {
    await client.end();
  }
}
import { RedisContainer } from '@testcontainers/redis';
import { RedpandaContainer } from '@testcontainers/redpanda';

/** Pinned images — keep in sync with infra/docker-compose.yml. */
export const IMAGES = {
  postgres: 'postgres:16-alpine',
  redis: 'redis:7-alpine',
  redpanda: 'redpandadata/redpanda:v26.2.6',
} as const;

export interface Started<T> {
  stop(): Promise<void>;
  value: T;
}

export async function startPostgres(): Promise<Started<{ url: string }>> {
  const c = await new PostgreSqlContainer(IMAGES.postgres).start();
  return { value: { url: c.getConnectionUri() }, stop: async () => void (await c.stop()) };
}

export async function startRedis(): Promise<Started<{ url: string }>> {
  const c = await new RedisContainer(IMAGES.redis)
    .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
    .start();
  return { value: { url: c.getConnectionUrl() }, stop: async () => void (await c.stop()) };
}

export async function startRedpanda(): Promise<Started<{ brokers: string[] }>> {
  const c = await new RedpandaContainer(IMAGES.redpanda).start();
  return { value: { brokers: [c.getBootstrapServers()] }, stop: async () => void (await c.stop()) };
}

/** Poll until `fn` returns a truthy value (or throw after timeout). */
export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  { timeoutMs = 15_000, intervalMs = 100, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ''}`);
}
