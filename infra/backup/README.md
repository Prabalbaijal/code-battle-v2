# Postgres backups (plan §18.3)

Postgres is the source of truth; everything else (Redis, Kafka) can be rebuilt from it. These two
scripts back it up and prove the backups restore. They drive the Postgres container through
`docker compose exec`, so they work the same on the dev laptop and on the VM.

## Back up

```sh
pnpm db:backup                         # → backups/<timestamp>/ (keeps the newest 7)
BACKUP_DIR=/srv/backups BACKUP_KEEP=14 COMPOSE_FILE=infra/compose.prod.yml pnpm db:backup
```

Each run writes one `pg_dump -Fc` per service database and a `manifest.json` with each dump's
SHA-256 and the row count of every table at dump time.

**Off-site copy (optional, free):** set `BACKUP_UPLOAD_CMD`, e.g.
`rclone copy {dir} r2:cb-backups/` with a Cloudflare R2 bucket. A failed upload exits 2; the local
backup is still there.

**Schedule:** nightly.

- VM (cron): `15 3 * * * cd /srv/code-battle && BACKUP_DIR=/srv/backups node infra/backup/backup.mjs >> /var/log/cb-backup.log 2>&1`
- Laptop (Task Scheduler): a daily task running `node infra/backup/backup.mjs` in the repo folder.

## Restore drill (do it monthly, and after schema changes)

```sh
pnpm db:restore-drill backups/<timestamp>
```

Restores every dump into a scratch `<db>_restore` database, then checks the dump's checksum, every
table's row count against the manifest, and that every table is owned by its service role again.
The scratch databases are dropped. Nothing live is touched. Run it on a quiet stack, or busy
tables (outbox, inbox) may differ by a few rows.

## Disaster recovery

1. Stop the services (keep Postgres running).
2. `node infra/backup/restore.mjs backups/<timestamp> --for-real --yes` (or `--only identity,battle`).
3. Start the services. Redis rebuilds itself (leaderboard rebuild, presence pings); outbox rows
   still unpublished in the dump are published by the relays.

## Drill log

| Date       | Backup                | Databases | Rows  | Result                                    |
| ---------- | --------------------- | --------- | ----- | ----------------------------------------- |
| 2026-11-12 | dev stack, 3.5 MB     | 9         | 5 769 | ✓ all counts and owners match, 47 s total |
| 2026-11-12 | `--for-real` template | 1         | 14    | ✓ live DB replaced, owner `template_svc`  |
