#!/usr/bin/env node
// Nightly Postgres backup (plan §18.3): one custom-format dump per service database, a manifest
// with checksums and per-table row counts (what the restore drill checks against), retention.
//
//   node infra/backup/backup.mjs
//   BACKUP_DIR=/srv/backups BACKUP_KEEP=14 COMPOSE_FILE=infra/compose.prod.yml node infra/backup/backup.mjs
//
// Off-site copy (optional): BACKUP_UPLOAD_CMD runs after a successful backup with {dir} replaced,
// e.g. `rclone copy {dir} r2:cb-backups/` (free R2). Without it, backups stay on the host disk.
/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cfg, databases, sha256, tableCounts, toFile } from './pg.mjs';

const root = resolve(process.env.BACKUP_DIR ?? 'backups');
const keep = Number(process.env.BACKUP_KEEP ?? 7);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = join(root, stamp);
mkdirSync(dir, { recursive: true });

const started = Date.now();
const manifest = { createdAt: new Date().toISOString(), composeFile: cfg.composeFile, databases: {} };
for (const db of databases()) {
  // counted just before the dump: run the drill on a quiet stack (or expect live tables to move)
  const counts = tableCounts(db);
  const file = join(dir, `${db}.dump`);
  await toFile(['pg_dump', '-U', cfg.user, '-d', db, '-Fc', '-Z', '6'], file);
  manifest.databases[db] = {
    file: `${db}.dump`,
    bytes: statSync(file).size,
    sha256: await sha256(file),
    counts,
  };
  console.log(
    `${db.padEnd(14)} ${String(statSync(file).size).padStart(10)} B  ${Object.keys(counts).length} tables`,
  );
}
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`backup ${dir} in ${((Date.now() - started) / 1000).toFixed(1)} s`);

// retention: keep the newest N backups
const all = readdirSync(root)
  .filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d))
  .sort();
for (const old of all.slice(0, Math.max(0, all.length - keep))) {
  rmSync(join(root, old), { recursive: true, force: true });
  console.log(`pruned ${old}`);
}

if (process.env.BACKUP_UPLOAD_CMD) {
  const cmd = process.env.BACKUP_UPLOAD_CMD.replaceAll('{dir}', dir);
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('off-site upload failed (the local backup is fine)');
    process.exit(2);
  }
}
