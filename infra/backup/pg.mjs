// Shared helpers for backup.mjs / restore.mjs: talk to the Postgres container through
// `docker compose exec`, so the same scripts work on the dev laptop and on the VM.
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export const cfg = {
  composeFile: process.env.COMPOSE_FILE ?? 'infra/docker-compose.yml',
  service: process.env.PG_SERVICE ?? 'postgres',
  user: process.env.PGUSER ?? 'cb',
};

// production: COMPOSE_FILE=infra/compose.prod.yml COMPOSE_ENV_FILE=infra/prod/.env
const envFile = process.env.COMPOSE_ENV_FILE ? ['--env-file', process.env.COMPOSE_ENV_FILE] : [];
const exec = (args) => ['compose', '-f', cfg.composeFile, ...envFile, 'exec', '-T', cfg.service, ...args];

/** Run psql and return the rows of a query (tab-separated, no header). */
export function psql(db, sql) {
  const r = spawnSync(
    'docker',
    exec(['psql', '-U', cfg.user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql]),
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`psql ${db}: ${r.stderr || r.stdout}`);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
}

/** Every application database (not the templates, not the maintenance db). */
export const databases = () =>
  psql(
    'postgres',
    "select datname from pg_database where not datistemplate and datname not in ('postgres', 'cb') and datname not like '%\\_restore' order by 1",
  ).map(([d]) => d);

/** Exact row count of every table in `public` (one statement, one snapshot). */
export function tableCounts(db) {
  const tables = psql(
    db,
    "select quote_ident(table_name) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
  ).map(([t]) => t);
  if (!tables.length) return {};
  const sql = tables
    .map((t) => `select '${t.replaceAll("'", "''")}', count(*) from public.${t}`)
    .join(' union all ');
  return Object.fromEntries(psql(db, sql).map(([t, n]) => [t.replaceAll('"', ''), Number(n)]));
}

/** Stream a command's stdout into a file. */
export async function toFile(args, file) {
  const p = spawn('docker', exec(args), { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const done = new Promise((res, rej) => p.on('close', (code) => (code === 0 ? res() : rej(new Error(err)))));
  await pipeline(p.stdout, createWriteStream(file));
  await done;
}

/** Stream a file into a command's stdin. */
export async function fromFile(args, file) {
  const p = spawn('docker', exec(args), { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const done = new Promise((res, rej) => p.on('close', (code) => (code === 0 ? res() : rej(new Error(err)))));
  await pipeline(createReadStream(file), p.stdin);
  await done;
}

export async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}
