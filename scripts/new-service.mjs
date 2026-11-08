#!/usr/bin/env node
// Scaffold a new service from apps/template-service.  Usage: pnpm new-service identity-service
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]*-service$/.test(name)) {
  console.error('usage: pnpm new-service <name>-service   (lowercase, ends with "-service")');
  process.exit(1);
}
const src = join(ROOT, 'apps/template-service');
const dest = join(ROOT, 'apps', name);
if (existsSync(dest)) {
  console.error(`apps/${name} already exists`);
  process.exit(1);
}

const SKIP = new Set(['node_modules', 'dist', '.turbo', 'drizzle']);
cpSync(src, dest, { recursive: true, filter: (p) => !SKIP.has(p.split(/[\\/]/).pop()) });

// Rename package + default service name everywhere in text files.
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|json|md)$/.test(entry)) {
      const before = readFileSync(p, 'utf8');
      const after = before
        .replaceAll('@cb/template-service', `@cb/${name}`)
        .replaceAll('template-service', name);
      if (after !== before) writeFileSync(p, after);
    }
  }
}
walk(dest);
rmSync(join(dest, 'src/test'), { recursive: true, force: true });

console.log(`Created apps/${name}. Next:
  1. Replace the greeting module (src/modules/greeting) and src/db/schema.ts with the service's own model.
  2. Add its database to infra/postgres/init.sql and its topics/queues to src/infra.ts and src/queues.ts.
  3. pnpm install && pnpm --filter @cb/${name} db:generate
  4. Add an integration test under src/test (copy the template's as a starting point).`);
