#!/usr/bin/env node
// Restore a backup made by backup.mjs.
//
//   node infra/backup/restore.mjs <backup-dir>              drill: restore every dump into a scratch
//                                                           `<db>_restore` database, check checksums
//                                                           and row counts against the manifest, drop
//                                                           the scratch databases. Touches nothing live.
//   node infra/backup/restore.mjs <backup-dir> --for-real --yes [--only identity,battle]
//                                                           disaster recovery: drop and recreate the
//                                                           live databases from the dumps. Stop the
//                                                           services first.
/* eslint-disable no-console */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cfg, fromFile, psql, sha256, tableCounts } from './pg.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('usage: restore.mjs <backup-dir> [--for-real --yes] [--only db1,db2]');
  process.exit(1);
}
const forReal = args.includes('--for-real');
if (forReal && !args.includes('--yes')) {
  console.error('--for-real replaces live databases: add --yes once the services are stopped');
  process.exit(1);
}
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const manifest = JSON.parse(readFileSync(join(resolve(dir), 'manifest.json'), 'utf8'));
const owner = (db) =>
  psql('postgres', `select pg_get_userbyid(datdba) from pg_database where datname = '${db}'`)[0]?.[0];

const started = Date.now();
const rows = [];
let failed = 0;
for (const [db, m] of Object.entries(manifest.databases)) {
  if (only && !only.includes(db)) continue;
  const file = join(resolve(dir), m.file);
  const problems = [];
  if ((await sha256(file)) !== m.sha256) problems.push('checksum mismatch');

  const target = forReal ? db : `${db}_restore`;
  const role = owner(db) ?? cfg.user;
  if (forReal) {
    psql(
      'postgres',
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${db}' and pid <> pg_backend_pid()`,
    );
  }
  psql('postgres', `drop database if exists "${target}"`);
  psql('postgres', `create database "${target}" owner "${role}"`);
  const t0 = Date.now();
  // as the superuser, keeping the dump's owners (the service roles exist): extensions such as
  // `vector` need a superuser, and every table must end up owned by its service role again
  await fromFile(['pg_restore', '-U', cfg.user, '-d', target, '--exit-on-error'], file);
  const ms = Date.now() - t0;

  const got = tableCounts(target);
  for (const [table, n] of Object.entries(m.counts)) {
    if (got[table] !== n) problems.push(`${table}: ${got[table] ?? 'missing'} rows, expected ${n}`);
  }
  // the services connect as their own role: every table must be theirs again, not the superuser's
  const foreign = psql(
    target,
    `select count(*) from pg_tables where schemaname = 'public' and tableowner <> '${role}'`,
  )[0][0];
  if (foreign !== '0') problems.push(`${foreign} table(s) not owned by ${role}`);
  if (!forReal) psql('postgres', `drop database "${target}"`);
  if (problems.length) failed++;
  rows.push({
    database: db,
    tables: Object.keys(m.counts).length,
    rows: Object.values(m.counts).reduce((a, b) => a + b, 0),
    'restore ms': ms,
    result: problems.length ? `✗ ${problems.slice(0, 3).join('; ')}` : '✓',
  });
}
console.table(rows);
console.log(
  `${forReal ? 'restored' : 'drill'} ${rows.length} database(s) from ${manifest.createdAt} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
if (failed) process.exit(1);
