import type { Logger } from '@cb/logger';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Schema-less drizzle database (services import their table objects directly). */
export type Db = NodePgDatabase<Record<string, never>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run queries: the db or an open transaction. Repositories take this. */
export type Executor = Db | Tx;

export interface DbHandle {
  pool: pg.Pool;
  db: Db;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  connectionString: string;
  /** Keep small: many services × pool size share one Postgres (plan §17.3). */
  max?: number;
  applicationName?: string;
  logger?: Logger;
}

export function createDb(opts: CreateDbOptions): DbHandle {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: opts.applicationName,
  });
  pool.on('error', (err) => opts.logger?.error({ err }, 'pg pool error'));
  const db = drizzle(pool) as Db;
  return {
    pool,
    db,
    ping: async () => {
      await pool.query('select 1');
      return true;
    },
    close: () => pool.end(),
  };
}

export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
