# Disaster recovery runbook

Operator procedures for restoring data from backup — see README's [Backup & maintenance](./README.md#backup--maintenance) for how backups are taken. Covers restoring from a `pg_dump` (Scenarios A & B) and point-in-time recovery via WAL archiving (Scenario C).

Read [Known limitations](#known-limitations) before you need this — it says plainly what this setup can't yet protect against.

---

## Before you start (Scenarios A & B — restoring from a `pg_dump`)

Scenario C (point-in-time restore) has its own self-contained steps below — these three don't apply there, since it restores to a *time* you choose, not a specific dump file.

1. **Identify which dump to restore.** Named `callowl-<UTC timestamp>.dump` — pick the most recent one from *before* the incident. Pre-rebrand dumps are `opencdr-<UTC timestamp>.dump`; both restore identically. Dashboard: **⋯** → Backups; or `ls -la ./backups` on the host.
2. **`pg_restore --clean --if-exists`** (used by both UI/API restore and `scripts/restore.sh`) drops and recreates conflicting objects itself — target DB doesn't need to be empty or pre-schema'd. Restoring *is* the wipe-and-replace.
3. **Restore has no undo.** If there's any doubt which dump to use, back up the current (possibly-broken) state first, so you can compare.

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

The host itself is gone — starting from nothing but this repo and a `.dump` copy from *off* the dead host.

**Only works if you already have a `.dump` (and ideally the PITR repo — see [Known limitations](#known-limitations)) somewhere other than the dead host.** If `OFFSITE_S3_ENDPOINT` was configured, both live in your off-host bucket; otherwise there's nothing to restore from unless you copied one off some other way.

1. Provision the new host, clone this repo, restore `.env` (from your own secrets management, not the repo). Pull the `.dump` into `./backups/` on the new host (`mc cp offsite/<bucket>/pg_dumps/<file> ./backups/`, or however you copied it off).
2. Bring the stack up normally (fresh, empty Postgres):
   ```bash
   podman-compose up --build -d
   ```
3. Wait for `db` to report healthy (`podman ps`) and the backend to finish booting (migrations run automatically). Schema now exists but is empty (or has whatever seeding put there).
4. Restore over it — same commands as Scenario A step 2. `--clean --if-exists` handles the just-seeded/empty tables fine.
5. Run the [post-restore verification checklist](#post-restore-verification-checklist).

---

## Scenario C — point-in-time restore

Use when you know (or can narrow down) roughly *when* an incident happened and the last daily `pg_dump` would lose too much, or there wasn't one recent enough. Continuous WAL archiving (pgBackRest → self-hosted MinIO) can restore to any point since the oldest retained base backup, not just a dump's exact moment.

**Materially different from Scenario A** — operates on Postgres's physical data directory, not a live `pg_restore` connection, and requires stopping `db` entirely.

**Stanza cutover (CallOwl rebrand):** the pgBackRest stanza moved from `opencdr` to `callowl` (no in-place rename — a fresh stanza/bucket). **Target at/after cutover**: `--stanza=callowl`, current `.env`'s `MINIO_BUCKET` (`callowl-pitr`), as below. **Target before cutover**: `--stanza=opencdr` plus explicit `-e PGBACKREST_REPO1_S3_BUCKET=opencdr-pitr` (don't rely on `$MINIO_BUCKET` — it now points elsewhere). The old stanza's chain is still present, just no longer extended.

1. **Pick your target time**, UTC (`YYYY-MM-DD HH:MM:SS`) — pgBackRest replays WAL up to (not past) this point. If in doubt, err *earlier*: you can re-run with a later target, but not recover data written after wherever you restored to without redoing it.
2. **Stop the stack**:
   ```bash
   podman-compose stop backend db
   ```
3. **Restore**, via a one-off container sharing `db`'s data volume:
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
   `-v open-cdr-platform_pgdata` is deliberately still the pre-rebrand volume name (pinned, not migrated). `--entrypoint pgbackrest` bypasses the image's normal Postgres-startup wrapper. `--delta` restores only what changed — safe against the existing (stopped) volume, no empty data dir needed.
4. **Start `db`**:
   ```bash
   podman-compose up -d db
   ```
   Postgres detects recovery mode and replays WAL to your target time automatically — no manual "apply WAL" step. Watch `podman logs callowl-db` for `database system is ready to accept connections`; confirm healthy via `podman ps` before continuing.
5. **Start the backend**:
   ```bash
   podman-compose up -d backend
   ```
6. Run the [post-restore verification checklist](#post-restore-verification-checklist) — **plus**: confirm data matches your target time specifically (a record created after the incident but before your target should be present; one created after your target should be genuinely absent).

**If it didn't land right** (wrong target, incident started earlier than thought): no partial undo. Stop `db`, re-run step 3 with a corrected target — `--delta` re-evaluates from the base backup each time, safe to repeat.

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

- **PITR (Scenario C) only covers what's been continuously archived.** A broken archiving stretch (MinIO unreachable, bad key) can't be recovered — check `podman logs callowl-db` for `[pgbackrest-init]`/`[pgbackrest-backup]`, and `pgbackrest info` inside `db`, to confirm archiving was actually healthy.
- **Single-host unless off-host sync is configured.** MinIO and Postgres run on the same host — protects against corruption/bad-migration scenarios, but not full host loss (Scenario B) by itself. `OFFSITE_S3_ENDPOINT` closes this for both artifacts (mirrors `./backups` and the MinIO PITR bucket on a schedule); unset, Scenario B is only survivable if you separately copied a `.dump` off some other way.
- **Restore is all-or-nothing** — no partial/selective restore of tables or rows.
