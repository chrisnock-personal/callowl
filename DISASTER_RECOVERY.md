# Disaster recovery runbook

Operator-facing procedures for restoring this platform's data from backup. See README's [Backup & maintenance](./README.md#backup--maintenance) for how backups are taken; this document is about getting them *back in*, under pressure, without guessing. Covers both restoring from a `pg_dump` (Scenarios A & B) and point-in-time recovery via continuous WAL archiving (Scenario C).

Read [Known limitations](#known-limitations) before you need this — it says plainly what this setup can't yet protect against.

---

## Before you start (Scenarios A & B — restoring from a `pg_dump`)

Scenario C (point-in-time restore) has its own self-contained steps below — these three don't apply there, since it restores to a *time* you choose, not a specific dump file.

1. **Identify which dump to restore.** Backups are named `callowl-<UTC timestamp>.dump` (e.g. `callowl-20260714T100500Z.dump`) — pick the most recent one from *before* whatever went wrong. Dumps from before the CallOwl rebrand are named `opencdr-<UTC timestamp>.dump` instead; both prefixes list and restore identically. The dashboard's header menu (**⋯** → Backups) lists recent ones with relative ages; `ls -la ./backups` on the host shows all of them.
2. **`pg_restore --clean --if-exists` (what both the UI/API restore and `scripts/restore.sh` use) drops and recreates conflicting objects as it goes — the target database does not need to be empty first, and does not need the schema pre-created.** You are not choosing between "restore" and "wipe first, then restore" — restoring *is* the wipe-and-replace, in one step.
3. **Restore has no undo.** Once it starts, whatever was in the target database before is gone. If there's any doubt about which dump to use, take a fresh backup of the current (possibly-broken) state first — worst case you can compare it against the one you're about to restore.

---

## Scenario A — restore onto a still-running stack

Data corruption, an accidental delete, a bad migration, a bad ingest — the containers are healthy, only the *data* is wrong.

1. Take a fresh backup of current state first (see step 3 above) — **Backup now** in the dashboard, or:
   ```bash
   podman-compose run --rm --entrypoint sh backup /scripts/backup.sh
   ```
2. Restore, either:
   - **Dashboard**: header menu (**⋯**) → Backups → **Restore…** → pick the `.dump` file → confirm the `window.confirm` prompt.
   - **CLI**:
     ```bash
     podman-compose run --rm --entrypoint sh backup /scripts/restore.sh /backups/callowl-<stamp>.dump
     ```
   - **API**: `POST /admin/backups/restore` with the raw `.dump` file as the body, `X-API-Key: <ADMIN_API_KEY>` if configured.
3. Run the [post-restore verification checklist](#post-restore-verification-checklist) below.
4. No restart needed — Postgres is a separate container from the backend; the backend's connection pool just starts seeing the restored data on its next query.

---

## Scenario B — full host loss, rebuild from scratch

The host itself is gone (disk failure, terminated instance, etc.) — you're starting from nothing but this repo and whatever `.dump` file you have a copy of *off* the dead host.

**This scenario only works if you already had a copy of a `.dump` file (and ideally the PITR repo — see [Known limitations](#known-limitations)) somewhere other than the dead host.** If `OFFSITE_S3_ENDPOINT` was configured (the `offsite-backup` compose service, `scripts/offsite-sync.sh`), both live in your off-host bucket; if it wasn't, there is nothing to restore from unless you copied a `.dump` off some other way.

1. Provision the new host, clone this repo, restore `.env` (not stored in the repo — from your own secrets management). Pull the `.dump` file down from your off-host bucket (`mc cp offsite/<bucket>/pg_dumps/<file> ./backups/` or your provider's own CLI/console) into `./backups/` on the new host — or, if you never configured off-host sync, whatever `.dump` file you separately copied off the dead host by hand.
2. Bring the stack up normally — this creates a fresh, empty Postgres:
   ```bash
   podman-compose up --build -d
   ```
3. Wait for `db` to report healthy (`podman ps` — the `healthcheck` in `docker-compose.yml` uses `pg_isready`) and for the backend to finish its own boot (migrations run automatically on startup — see `runMigrations()`, `backend/src/index.ts`). At this point the schema exists but is empty (or has whatever `SEED_EXAMPLES`/bootstrap-admin seeding put there — see README's [Quick start](./README.md#quick-start)).
4. Restore over that fresh schema — same commands as Scenario A step 2. `--clean --if-exists` handles replacing the just-seeded/empty tables fine.
5. Run the [post-restore verification checklist](#post-restore-verification-checklist) below.

---

## Scenario C — point-in-time restore

Data corruption, a bad migration, or an accidental delete where you know (or can narrow down) roughly *when* it happened, and restoring to the last daily `pg_dump` would lose too much — or there simply wasn't one recent enough. Continuous WAL archiving (pgBackRest, to the self-hosted MinIO target — see `postgres/pgbackrest.conf`, `docker-compose.yml`'s `db` service) can restore to any point since the oldest retained base backup, not just to a dump's exact moment.

**This is a materially different procedure from Scenario A** — it operates on Postgres's own physical data directory, not a live `pg_restore` connection, and requires stopping `db` entirely for the duration.

**Stanza cutover note (CallOwl rebrand):** the pgBackRest stanza was cut over from `opencdr` to `callowl` during the rebrand — pgBackRest has no in-place rename, so this was a fresh stanza/bucket rather than a renamed one. **Targeting a time at or after the cutover** uses `--stanza=callowl` and the current `.env`'s `MINIO_BUCKET` (`callowl-pitr`) as shown below. **Targeting a time before the cutover** needs `--stanza=opencdr` instead, plus `-e PGBACKREST_REPO1_S3_BUCKET=opencdr-pitr` explicitly (don't rely on `$MINIO_BUCKET` from the current `.env` — it now points at the new bucket) — the old stanza's backup chain is still physically present and untouched, just no longer extended.

1. **Pick your target time**, as precise as you can get, in UTC (`YYYY-MM-DD HH:MM:SS`) — pgBackRest replays WAL up to (but not past) this point. If in doubt, err slightly *earlier* than the incident; you can always re-run with a later target, but you can't recover data written after whatever point you restore to without redoing the whole restore.
2. **Stop the stack** (data is unreachable during the restore regardless):
   ```bash
   podman-compose stop backend db
   ```
3. **Restore**, via a one-off container using the same image, sharing `db`'s actual data volume:
   ```bash
   podman run --rm \
     -v open-cdr-platform_pgdata:/var/lib/postgresql/data \
     --network callowl_default \
     -e PGBACKREST_REPO1_S3_KEY="$MINIO_ROOT_USER" \
     -e PGBACKREST_REPO1_S3_KEY_SECRET="$MINIO_ROOT_PASSWORD" \
     -e PGBACKREST_REPO1_S3_BUCKET="$MINIO_BUCKET" \
     --user postgres \
     --entrypoint pgbackrest \
     localhost/callowl_db:latest \
     --stanza=callowl --type=time --target="2026-07-22 14:30:00" --delta restore
   ```
   (The `-v open-cdr-platform_pgdata` volume name is intentionally still the pre-rebrand name — see `docker-compose.yml`'s `volumes:` section; it was deliberately pinned rather than migrated.)
   `--entrypoint pgbackrest` overrides the image's default entrypoint (the pgBackRest-init wrapper around Postgres's own startup, which isn't what you want for a one-off restore command).
   `--delta` restores only what's actually changed rather than requiring a fully empty data directory first — safe to run directly against `db`'s existing (stopped) volume.
4. **Start `db` back up normally:**
   ```bash
   podman-compose up -d db
   ```
   Postgres itself detects it's in recovery, replays the archived WAL up to your target time, and reaches a consistent state automatically — there's no separate "apply the WAL" step to run by hand. Watch `podman logs callowl-db` for `database system is ready to accept connections`, and confirm the healthcheck (`podman ps`) reports healthy before continuing.
5. **Start the backend back up:**
   ```bash
   podman-compose up -d backend
   ```
6. Run the [post-restore verification checklist](#post-restore-verification-checklist) below — **plus**: confirm the data reflects what you'd expect as of your target time specifically (e.g. a record you know was created *after* the incident but *before* your target time should be present; one created after your target time should be genuinely absent, not just "some data exists").

**If the restore didn't land where you meant it to** — wrong target time, or the incident turns out to have started earlier than you thought — there's no partial undo. Stop `db` again and re-run step 3 with a corrected target; `--delta` re-evaluates from the base backup each time, so this is safe to repeat.

---

## Post-restore verification checklist

Run these after *any* restore, before considering the incident closed.

1. **Migrations table matches the repo.** `backend/src/migrations/` currently has 8 files; `schema_migrations` should have exactly that many rows:
   ```bash
   podman exec callowl-db psql -U "$PGUSER" -d "$PGDATABASE" -c "SELECT count(*) FROM schema_migrations;"
   ```
   A mismatch means you restored a dump from before/after a schema change relative to the code currently deployed — investigate before trusting anything else.
2. **`call_records` row count is sane** — not zero (unless you genuinely expected an empty store), not wildly different from what you'd expect for the dump's age:
   ```bash
   podman exec callowl-db psql -U "$PGUSER" -d "$PGDATABASE" -c "SELECT count(*) FROM call_records;"
   ```
3. **Login works** — proves the `users`/`sessions` tables survived the restore intact, not just `call_records`. Log into the dashboard with a real account.
4. **Spot-check one known record** — open a record in the dashboard you know should exist (by `callId`, via the Filters popover's Call ID field) and confirm its content looks right, not just that *a* row exists.

If any of these fail, do not assume the restore is "mostly fine" — figure out why before resuming normal operation.

---

## Known limitations

- **Point-in-time restore (Scenario C) only covers what's been continuously archived.** If WAL archiving itself was ever broken (MinIO unreachable, a misconfigured key) for a stretch of time, that stretch can't be recovered — check `podman logs callowl-db` for `[pgbackrest-init]`/`[pgbackrest-backup]` lines, and `pgbackrest info` (run inside the `db` container) to confirm archiving has actually been healthy; don't just assume it has been.
- **Single-host by default, unless off-host sync is configured.** MinIO and Postgres are separate containers but run on the same host — this protects against the corruption/bad-migration/accidental-delete scenarios PITR exists for, but MinIO's own data lives in a volume on that same host, so it does **not** by itself protect against the full host loss Scenario B describes, the way an off-host `pg_dump` copy would. Setting `OFFSITE_S3_ENDPOINT` (the `offsite-backup` compose service, `scripts/offsite-sync.sh`) closes this for both artifacts — it mirrors `./backups` *and* the MinIO PITR bucket to a separate S3-compatible target on a schedule (`OFFSITE_SYNC_INTERVAL_HOURS`), surfaced in the dashboard's Backups panel the same way pg_dump/PITR staleness already is. Left unset, the gap is exactly as described above: nothing leaves this host automatically, and Scenario B is only survivable if *you* separately copied a `.dump` off some other way.
- **Restore replaces the whole database, not selected tables/rows.** There's no partial/selective restore — it's all-or-nothing via `pg_restore --clean --if-exists`.
