import { createDb, runMigrations } from '@cb/db';
import { fileURLToPath } from 'node:url';

/** drizzle/ sits two levels above both src/db and dist/db. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function migrate(databaseUrl: string): Promise<void> {
  const h = createDb({ connectionString: databaseUrl, max: 1 });
  try {
    await runMigrations(h.db, MIGRATIONS_DIR);
  } finally {
    await h.close();
  }
}

// `pnpm db:migrate` entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  await migrate(url);
}
