# Disaster recovery runbook

Operator-facing procedures for restoring this platform's data from backup. See README's [Backup & maintenance](./README.md#backup--maintenance) for how backups are taken; this document is about getting them *back in*, under pressure, without guessing.

Read [Known limitations](#known-limitations) before you need this — it says plainly what this setup can't yet protect against.

---

## Before you start, in any scenario

1. **Identify which dump to restore.** Backups are named `opencdr-<UTC timestamp>.dump` (e.g. `opencdr-20260714T100500Z.dump`) — pick the most recent one from *before* whatever went wrong. The dashboard's header menu (**⋯** → Backups) lists recent ones with relative ages; `ls -la ./backups` on the host shows all of them.
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
     podman-compose run --rm --entrypoint sh backup /scripts/restore.sh /backups/opencdr-<stamp>.dump
     ```
   - **API**: `POST /admin/backups/restore` with the raw `.dump` file as the body, `X-API-Key: <ADMIN_API_KEY>` if configured.
3. Run the [post-restore verification checklist](#post-restore-verification-checklist) below.
4. No restart needed — Postgres is a separate container from the backend; the backend's connection pool just starts seeing the restored data on its next query.

---

## Scenario B — full host loss, rebuild from scratch

The host itself is gone (disk failure, terminated instance, etc.) — you're starting from nothing but this repo and whatever `.dump` file you have a copy of *off* the dead host.

**This scenario is where [the off-host-copy gap](#known-limitations) bites — it only works if you already had a copy of a `.dump` file somewhere other than the dead host's `./backups` directory.** If you don't, there is nothing to restore from; this is the whole reason that limitation is called out below instead of left implicit.

1. Provision the new host, clone this repo, restore `.env` (not stored in the repo — from your own secrets management) and the `.dump` file you copied off-host into `./backups/` on the new host.
2. Bring the stack up normally — this creates a fresh, empty Postgres:
   ```bash
   podman-compose up --build -d
   ```
3. Wait for `db` to report healthy (`podman ps` — the `healthcheck` in `docker-compose.yml` uses `pg_isready`) and for the backend to finish its own boot (migrations run automatically on startup — see `runMigrations()`, `backend/src/index.ts`). At this point the schema exists but is empty (or has whatever `SEED_EXAMPLES`/bootstrap-admin seeding put there — see README's [Quick start](./README.md#quick-start)).
4. Restore over that fresh schema — same commands as Scenario A step 2. `--clean --if-exists` handles replacing the just-seeded/empty tables fine.
5. Run the [post-restore verification checklist](#post-restore-verification-checklist) below.

---

## Post-restore verification checklist

Run these after *any* restore, before considering the incident closed.

1. **Migrations table matches the repo.** `backend/src/migrations/` currently has 8 files; `schema_migrations` should have exactly that many rows:
   ```bash
   podman exec opencdr-db psql -U "$PGUSER" -d "$PGDATABASE" -c "SELECT count(*) FROM schema_migrations;"
   ```
   A mismatch means you restored a dump from before/after a schema change relative to the code currently deployed — investigate before trusting anything else.
2. **`call_records` row count is sane** — not zero (unless you genuinely expected an empty store), not wildly different from what you'd expect for the dump's age:
   ```bash
   podman exec opencdr-db psql -U "$PGUSER" -d "$PGDATABASE" -c "SELECT count(*) FROM call_records;"
   ```
3. **Login works** — proves the `users`/`sessions` tables survived the restore intact, not just `call_records`. Log into the dashboard with a real account.
4. **Spot-check one known record** — open a record in the dashboard you know should exist (by `callId`, via the Filters popover's Call ID field) and confirm its content looks right, not just that *a* row exists.

If any of these fail, do not assume the restore is "mostly fine" — figure out why before resuming normal operation.

---

## Known limitations

- **No point-in-time recovery.** A `pg_dump` only ever restores to the exact moment it was taken — anything written between the last dump and the incident is gone. Continuous WAL archiving would close this gap; not implemented yet (see README Roadmap).
- **Backups are not copied off-host automatically.** `./backups` lives on the same host as the database it's backing up. A full host loss (Scenario B) is only survivable if *you* have separately copied `.dump` files elsewhere (another host, object storage, wherever) — this platform doesn't do that step for you today.
- **Restore replaces the whole database, not selected tables/rows.** There's no partial/selective restore — it's all-or-nothing via `pg_restore --clean --if-exists`.
