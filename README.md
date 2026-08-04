# CallOwl

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](./LICENSE)

A reference **call-logging platform** for the [Open CDR Standard](./backend/src/data/cdr-schema.yaml) — the vendor-neutral Call Detail Record schema. It ingests CDRs written to the standard, stores them, and serves the standard's read API (list, fetch, statistics, health) plus a dashboard for browsing calls, participants, and event timelines.

It's the "open call-logging platform for ingesting CDR data" described as future work in the standard, built as a runnable prototype.

Node + Express + TypeScript + PostgreSQL on the backend (zod validation, `pg` pool, sequential SQL migrations, Swagger UI), React 18 + Vite on the frontend, deployed via compose.

---

## Quick start

```bash
cp .env.example .env      # adjust credentials if you like
podman-compose up --build # or:  docker compose up --build
```

Then open the dashboard at **http://localhost:8080**.

On first boot the backend runs migrations and seeds the five example scenarios from the standard (simple inbound, IVR/ACD queue, outbound, conference, transfer), so the dashboard has data immediately. The default time window covers those samples (2024-06-01).

For a fuller demo — enough volume for the Insights charts, drill-across, and advanced filter to actually have something to show — run `npm run seed:demo` from `backend/` (or `podman-compose run --rm backend node dist/db/seedDemo.js` against a running compose stack). It generates 5,000 schema-conformant records spread across the last 6 months: multi-leg transfers, multi-participant conferences, IVR/queue routing, QoS metrics (including a deliberate tail of poor-quality calls), supervisor monitor/barge-in, recording and transcription references (correlated to each other, not every recording gets transcribed), and every other field in the standard (device info, wrap-up notes, vendor-specific fields, participant join/leave/slot/handset detail) — not just the common ones. Every generated record is validated against the schema before ingest. This is a manual, opt-in step (unlike the five standard examples, it doesn't run automatically on boot) — it's meant for demoing or load-testing the dashboard, not a fresh-install default.

Want a full year of history instead (e.g. to exercise the wider Range presets, or show seasonality in the throughput charts)? `npm run seed:demo:12mo` runs the exact same generator spread across the last 12 months rather than 6, tagged with a `demo12mo-` callId prefix instead of `demo5k-` so the two batches stay independently identifiable — still 5,000 records, just spread thinner. Both are additive and safe to run alongside each other.

Services:

- **frontend** — nginx serving the built React app, reverse-proxying `/api` to the backend (host port `8080`)
- **backend** — the Express API on port `3001`
- **db** — PostgreSQL 16, custom-built with `pgBackRest` for continuous WAL archiving (named volume `pgdata`)
- **backup** — scheduled `pg_dump`s to `./backups` on the host; see [Backup & maintenance](#backup--maintenance)
- **minio** / **minio-init** — self-hosted S3-compatible object storage, the `pgBackRest` archiving target for point-in-time recovery; internal-only, no host port (named volume `miniodata`)

---

## API

Base path: `/api/cdr/v1`. Interactive docs (Swagger UI) at `/api/cdr/v1/docs`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/calls` | List CDRs — filter by time window, media type, groups, tenant; paginated |
| `GET` | `/calls/{callId}` | Fetch a single CDR |
| `GET` | `/statistics/summary` | Aggregate stats for a window |
| `GET` | `/statistics/top-talkers` | **Platform extension** — participants ranked by call count/talk time for a window |
| `GET` | `/statistics/throughput` | **Platform extension** — call volume bucketed by hour or day over a window |
| `GET` | `/statistics/throughput/by-outcome` | **Platform extension** — call volume bucketed by hour or day, split into answered vs. unanswered counts |
| `GET` | `/statistics/by-platform` | **Platform extension** — call counts grouped by `sourcePlatformId` |
| `GET` | `/statistics/handle-time` | **Platform extension** — average call duration bucketed by hour or day |
| `GET` | `/statistics/handle-time/by-agent` | **Platform extension** — agents ranked by average handle time, longest first |
| `GET` | `/statistics/queue-wait` | **Platform extension** — average queue wait time bucketed by hour or day |
| `GET` | `/statistics/queue-wait/by-queue` | **Platform extension** — queues ranked by average wait, longest first |
| `GET` | `/statistics/worst-mos` | **Platform extension** — voice calls with the lowest MOS (call quality) in a window, worst first |
| `GET` | `/statistics/ivr-time` | **Platform extension** — average time spent in IVR bucketed by hour or day |
| `GET` | `/statistics/ivr-time/by-ivr` | **Platform extension** — IVRs ranked by average traversal time, longest first |
| `GET` | `/admin/backups` | **Platform extension** — read-only status on backups (filenames, sizes, retention) |
| `POST` | `/admin/backups` | **Platform extension** — trigger a `pg_dump` now (optionally `ADMIN_API_KEY`-gated, or a logged-in admin session) |
| `GET` | `/admin/backups/{filename}/download` | **Platform extension** — download a backup file (optionally gated) |
| `POST` | `/admin/backups/restore` | **Platform extension** — restore from an uploaded `.dump` file (optionally gated, destructive) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/admin/users` | **Platform extension**, admin-only — manage dashboard/API user accounts (see [Authentication & scoped access](#authentication--scoped-access)) |
| `GET` | `/admin/audit-log` | **Platform extension**, admin-only — who queried/ingested/administered what (see [Audit log](#audit-log)) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/admin/remote-sources` | **Platform extension**, admin-only — configure remote Open-CDR sources to pull from (see [Roadmap](#roadmap)) |
| `POST` | `/admin/remote-sources/{id}/poll` | **Platform extension**, admin-only — trigger a pull from that source now |
| `GET` | `/admin/remote-sources/{id}/rejects` | **Platform extension**, admin-only — pulled records that failed validation, paginated |
| `POST` | `/auth/login` | **Platform extension** — username/password login, sets a session cookie |
| `POST` | `/auth/logout` | **Platform extension** — invalidates the current session |
| `GET` | `/auth/me` | **Platform extension** — the logged-in user, or `401` |
| `GET`/`POST`/`DELETE` | `/auth/api-keys` | **Platform extension**, self-service — manage your own API keys (see [Authentication & scoped access](#authentication--scoped-access)) |
| `GET` | `/health` | Health + version probe (unauthenticated) |
| `POST` | `/calls/ingest` | **Platform extension** — ingest one record or an array (`INGEST_API_KEY` or a per-user API key) |

`GET /calls` supports the standard's documented parameters: `startTime` and `endTime` (both required, UTC ISO-8601), `mediaType` (comma-delimited), `groups` / `excludeGroups` (comma-delimited), `page`, `pageSize` (max 1000), and the `X-Tenant-Id` header. Records are ordered by `lastUpdateTime` (falling back to `endTime`, then `startTime`) ascending. Platform extensions on top: `sourcePlatformId` (comma-delimited), `participant` (matches `participantId`/`userId`/`displayName`/`extension`), `queue` (matches `callSource.queueInfo`, comma-delimited), `ivr` (matches `callSource.ivrInfo`, comma-delimited), and `advanced` — numeric conditions the fixed filters can't express, e.g. `advanced=mos < 3, jitter > 50` (comma-separated, ANDed). Supported fields: `mos`, `jitter`, `latency`, `packetLoss` (all from `qos`), `duration` (`durationSeconds`), `ivrTime`/`queueTime` (`callSource.timeInIvrSeconds`/`timeInQueueSeconds`); operators: `<`, `<=`, `>`, `>=`, `=`, `!=`. Field names are a fixed allowlist mapped to specific SQL column expressions server-side — an unknown field or malformed clause is rejected with `400`, and no part of the expression is ever interpolated directly into SQL. In the dashboard, this lives in the Filters popover as an **Advanced** field.

All of the above except `/health`, `/openapi.json`, `/docs`, and `POST /calls/ingest` require a logged-in session — see [Authentication & scoped access](#authentication--scoped-access).

The `/statistics/*` insights endpoints share `startTime`/`endTime`, `mediaType`, `groups`/`excludeGroups`, `sourcePlatformId`, and `X-Tenant-Id` with `GET /calls`. `top-talkers`, `by-agent`/`by-queue`/`by-ivr` breakdowns, and `worst-mos` also take `limit` (default 10, max 50); the trend endpoints (`throughput`, `handle-time`, `queue-wait`, `ivr-time`) take `bucket` (`hour` | `day`, default `day`). `top-talkers` and `handle-time/by-agent` exclude system-component roles (`ivr`/`queue`/`voicemail`/`unknown`) so they reflect people, not routing components. `worst-mos` only considers calls with a `qos.mosScore` present (voice calls with QoS reporting), ordered ascending (worst quality first).

### Ingesting records

The standard defines a read-only API, so ingestion is a platform extension. Every record is validated against the standard before it is stored — out-of-vocabulary enum values or missing required fields are rejected with a 400, so the store only ever holds conforming records. Records are upserted by `callId`.

```bash
curl -X POST http://localhost:8080/api/cdr/v1/calls/ingest \
  -H "Content-Type: application/json" \
  -d @my-call.json
```

To require auth, set `INGEST_API_KEY` in `.env`; clients then send `X-API-Key: <key>`. Left blank, ingest is open (fine for a local lab). A per-user API key works too, as an alternative to the shared secret — see [Authentication & scoped access](#authentication--scoped-access). The dashboard's **Ingest records** button posts JSON straight to this endpoint.

---

## Authentication & scoped access

Logging in is always required — there's no open mode for the dashboard or the read API (`GET /calls`, `GET /calls/{callId}`, `/statistics/*`, `GET /admin/backups`). `POST /calls/ingest` is the one exception: it's machine-to-machine (a switch/connector posting records), so it keeps its own separate `INGEST_API_KEY` gate rather than requiring a person to log in.

**Login** is a username/password form (dashboard's `LoginScreen`, or `POST /auth/login` directly) that sets an `httpOnly` session cookie — no tokens for frontend JS to manage. Sessions are DB-backed (a `sessions` table, 7-day expiry), so logout (`POST /auth/logout`) and deleting a user immediately and fully invalidate their session, unlike a stateless signed token. The cookie is `sameSite: Lax` and non-`Secure` by default, since the stack runs over plain HTTP by default (see [Status](#status)) and browsers silently drop `Secure` cookies over non-HTTPS; set `COOKIE_SECURE=true` in `.env` only once this is actually served behind TLS.

**Bootstrap admin** — on first boot, if the `users` table is empty, one admin account is created from `BOOTSTRAP_ADMIN_USERNAME` (default `admin`) / `BOOTSTRAP_ADMIN_PASSWORD`. Leave the password blank and one is generated and printed once to the backend's startup logs (`podman-compose logs backend` / `docker compose logs backend`) — save it from there, it isn't stored anywhere else in recoverable form.

**Managing users** — admin-only, via the dashboard's header menu (**⋯** → **Users**): add a user (username, password, role, optional scope), edit one (role, scope, and/or reset the password — leave the password field blank to keep it unchanged), or delete one. Each user is `admin` or `viewer`; only admins see the Users panel or can manage backups/restore. Editing your own account and changing your role away from `admin` asks for confirmation first, since it takes effect immediately and could lock you out.

**Scoped access** — each user has `allowedGroups` and `allowedSourcePlatformIds`, either `null` (unrestricted) or a specific list. A scoped user's requests are constrained to their allowed set: an unfiltered request defaults to their full allowed set, and an explicit filter is intersected with it — a user can never widen their own access by asking for more, and asking for something entirely outside their scope returns zero records rather than an error (so the boundary isn't discoverable by probing). Set scope as a comma-separated list in the add-user form; blank means unrestricted.

**Existing key-based auth still works unchanged** — `ADMIN_API_KEY` (backup/restore) and `INGEST_API_KEY` (ingest) are untouched by any of this. A logged-in admin session is accepted as an *alternative* to `ADMIN_API_KEY` on the backup/restore actions, so the dashboard doesn't need a key pasted in once real accounts exist, but existing scripts using the key keep working exactly as before.

**Per-user API keys** — every logged-in user (admin or viewer) can generate named, revocable API keys for themselves from the header menu (**⋯** → **API keys**), for scripts or dashboards that shouldn't need a browser session. A key acts as its owner: same role, same `allowedGroups`/`allowedSourcePlatformIds`, enforced through the same scoping path as the session cookie. Send it as `X-API-Key` on any read-API request (`GET /calls`, `/statistics/*`, `GET /admin/backups`) as an alternative to the cookie, or on `POST /calls/ingest` as an alternative to `INGEST_API_KEY`. The raw key is shown exactly once at creation — only a hash is stored, so it can't be recovered afterward, only revoked (**Revoke** in the same panel) or replaced with a new one. Deleting a user cascades to their keys.

---

## Audit log

Every request that reaches a route with compliance value is logged — who (or what) made it, when, the method/path, the resulting status code, and how many records were involved for the couple of endpoints where that's cheap to capture (`GET /calls`, `POST /calls/ingest`). This covers queries, ingest, and every admin-ish action: login/logout (including failed attempts), user management, API key management, and backup/restore. `GET /health`, `/openapi.json`, `/docs`, and `GET /auth/me` are deliberately excluded — no compliance value, would just be noise (the last one fires on every dashboard page load).

Logging is a single global middleware (`backend/src/middleware/audit.ts`), not calls scattered through each route handler, so a new endpoint can't silently end up unaudited. The "actor" on each row is one of: `user` (a session cookie or a per-user API key — both resolve to the same username), `ingest_key`/`admin_key` (the shared `INGEST_API_KEY`/`ADMIN_API_KEY` secrets — not attributable to a person), or `anonymous` (no valid credential at all — what a failed login or a bare `401` looks like). A failed login attempt records the *attempted* username so it's still attributable, and never the password.

**Viewing it** — admin-only, via the header menu (**⋯** → **Audit log**): a paginated, filterable table (actor, method, path prefix, date range). Entries are kept for `AUDIT_LOG_RETENTION_DAYS` (default `90`), pruned once on boot and daily thereafter — no separate sidecar service needed, unlike scheduled backups (this is a plain SQL delete, not a `pg_dump`).

---

## How it's stored

One table, `call_records`. The full spec-compliant CallRecord is kept verbatim in a JSONB `record` column, so responses are faithful to the standard byte-for-byte. Alongside it, a handful of scalar columns are projected from the record at ingest time purely to make the documented filters fast and indexable: the time fields, `call_state`, `media_type`, `tenant_id`, and a denormalised `groups` array (the distinct `participants[].group` values, for array-overlap include/exclude filtering). Statistics are derived from these columns and from `callSource` routing fields.

Layout:

```
backend/src/
  config/        env config (zod-validated)
  db/            pg pool, migration runner, example seeder, bootstrap admin seeder, rich demo data generators (6mo + 12mo variants)
  migrations/    sequential SQL (001 table, 002 indexes, 003+ backfills, 005 users/sessions, 006 API keys, 007 audit log, 008 remote sources)
  schemas/       zod mirror of the standard — the ingest gatekeeper
  services/      ingest, read (list/get), statistics, auth (users/sessions/API keys), audit log, advanced filter parsing,
                 remote source CRUD/auth/polling, secret encryption
  middleware/    auth (session cookie, API keys, access scoping), audit logging
  routes/        calls, statistics, health, admin, auth
  openapi.ts     serves the standard's YAML + the platform extensions
  data/          cdr-schema.yaml, cdr-examples.json (served & seeded)
frontend/src/
  App.tsx        dashboard: login, filters, stats, records table, detail drawer, user management
  api.ts         typed client
scripts/
  backup.sh      pg_dump + retention pruning — runs on a loop in the `backup` service
  restore.sh     pg_restore from a dump produced by backup.sh
```

---

## Backup & maintenance

**Scheduled** — the `backup` compose service (plain `postgres:16-alpine`, which already ships `pg_dump`/`pg_restore`) runs `scripts/backup.sh` on a loop: dump on start, sleep `BACKUP_INTERVAL_HOURS` (default `24`), repeat. Dumps land in `./backups` on the host as `callowl-<UTC timestamp>.dump` (custom pg_dump format, compressed), and each run prunes dumps older than `BACKUP_RETENTION_DAYS` (default `14`). Both are set in `.env`. Every run (success or failure) writes `./backups/.last-attempt`, surfaced in the dashboard's Backups panel — a backup more than two intervals overdue, or whose last scheduled attempt failed, renders as a warning there instead of failing silently (previously the only trace of a broken backup loop was `podman logs`).

**On-demand, from the dashboard** — the header menu (**⋯**, top right) has a full Backups panel: last-backup time and retention summary, a scrollable list of recent dumps with a **⬇ download** action each, a **Backup now** button, and a **Restore…** button (pick a `.dump` file, confirm, and it replaces the database outright via `pg_restore --clean --if-exists`). The backend carries its own `pg_dump`/`pg_restore` (installed from the versioned PGDG apt repo — Debian's default package is v15, and pg_dump refuses to dump a *newer* server than itself, so it has to match the v16 server) and mounts `./backups` read-write, alongside the scheduled service.

**On-demand, from the API** — same three actions: `POST /admin/backups` (trigger), `GET /admin/backups/{filename}/download`, `POST /admin/backups/restore` (body is the raw `.dump` file). `GET /admin/backups` (the list) just needs a logged-in session, like the rest of the read API; the three action endpoints above additionally accept `ADMIN_API_KEY` (`X-API-Key` header) as an alternative to a logged-in admin session — unset by default (fine for a local lab), **strongly recommended once this is reachable beyond one**, since restore has no undo.

**Manual, from the CLI** — the `backup` service's entrypoint is the loop itself, so a one-off run needs `--entrypoint` to invoke a script directly instead:

```bash
# Backup now
podman-compose run --rm --entrypoint sh backup /scripts/backup.sh

# Restore a dump (drops and recreates conflicting objects — --clean --if-exists)
podman-compose run --rm --entrypoint sh backup /scripts/restore.sh /backups/callowl-<stamp>.dump
```

**Point-in-time recovery (PITR)** — a `pg_dump` only ever restores to the exact moment it was taken; anything written since is gone. `db` is a custom-built image (`postgres/Dockerfile`) that continuously archives WAL segments via `pgBackRest` to a self-hosted **MinIO** target (`minio`/`minio-init` compose services), with `archive_timeout=60` forcing a segment switch at least every minute even when idle. A background loop (`postgres/docker-entrypoint-wrapper.sh`) also takes a full base backup every `PITR_BACKUP_INTERVAL_HOURS` (default `24`). Together this can restore to *any point* since the oldest retained base backup, not just to a dump's exact moment — see **[DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md)**'s Scenario C for the restore procedure. Both halves of PITR health (WAL-archiving freshness, straight from Postgres's own `pg_stat_archiver`; base-backup success, via the same `.last-attempt`-style marker file `pg_dump` uses) are surfaced in the same dashboard Backups panel as the pg_dump warning above.

**Actually recovering from an incident** — see **[DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md)** for step-by-step procedures (restoring onto a still-running stack vs. rebuilding a fully lost host), a post-restore verification checklist, and this setup's known limitations (point-in-time restore only covers what's been continuously archived, backups aren't copied off-host automatically). Rehearsed against a scratch database, not just written from memory.

Routine maintenance beyond backups (autovacuum, index bloat, etc.) is handled by Postgres's own defaults, which are on out of the box in the `postgres:16-alpine` image — nothing extra configured here.

---

## Deploying

`.env.example`'s defaults are intentionally open for a local lab (no auth on ingest, no TLS). For anything reachable beyond your own machine, start from `.env.production.example` instead — it documents which values are *required* (`INGEST_API_KEY`, `ADMIN_API_KEY`, a real `PGPASSWORD`, `BOOTSTRAP_ADMIN_PASSWORD`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` — same posture as `PGPASSWORD`, since these double as the S3 credentials `pgBackRest` uses against MinIO) and which need a TLS-terminating reverse proxy in front before it's safe to flip (`COOKIE_SECURE`).

Already in place regardless of which `.env` you use:

- `helmet` security headers (HSTS, `X-Content-Type-Options`, `X-Frame-Options`, hides `X-Powered-By`, etc.) — CSP is deliberately left off, since Swagger UI's bundled `/docs` relies on inline scripts and a hand-tuned CSP for one page isn't worth it here.
- Rate limiting on `POST /auth/login` (20 attempts / 15 min per IP), alongside the existing higher-volume limiter on `POST /calls/ingest`.
- `trust proxy` set for one reverse-proxy hop, so the audit log and both rate limiters resolve the real client IP once a proxy sits in front, instead of the proxy's own address.
- The backend container runs as a non-root user. `docker-entrypoint.sh` fixes up the `./backups` bind mount's ownership at container start rather than at build time — a build-time `chown` alone isn't enough under rootless Podman's default UID namespace remapping, where the image's `node` user and the host account can both report uid 1000 without actually being the same identity.
- `CORS_ORIGIN` is configurable (defaults to `*`, fine for a local lab) — pin it to your real origin once deployed, as defense in depth. Session auth doesn't depend on this either way, since cookies aren't sent cross-origin regardless (not configured with `credentials: true`).

Only required if you configure a remote source to pull CDRs from (**⋯** → **Remote sources**, see [Roadmap](#roadmap)): `REMOTE_SOURCE_ENC_KEY` (32 bytes, base64 — `openssl rand -base64 32`) encrypts that source's credential at rest; creating a source without it set returns a 501. `REMOTE_SOURCE_REJECTS_RETENTION_DAYS` (default 90) controls how long rejected-record entries are kept, pruned the same way the audit log is. `frontend/nginx.conf`'s `/api/` proxy also has a 150s `proxy_read_timeout`, deliberately above a "custom" source's own worst-case script runtime (120s timeout + 5s kill grace), so an on-demand **Poll now** click on a legitimately-slow-but-working script doesn't get a spurious 504 while the backend is still correctly finishing the job server-side.

Similarly, `MFA_ENC_KEY` (same format) is only required once a user actually enables MFA (**⋯** → **Security**) — enrolling without it set returns a 501.

**Rotating any of the four secrets** (`ADMIN_API_KEY`, `INGEST_API_KEY`, `REMOTE_SOURCE_ENC_KEY`, `MFA_ENC_KEY`) — see **[SECRETS_ROTATION.md](./SECRETS_ROTATION.md)**. All four support a rotation window (old and new both valid at once via a comma-separated value or a `_PREVIOUS` env var, depending on the secret), so rotating never requires every caller to switch at the exact same instant.

Still up to you: TLS itself (Caddy is the easiest option — auto-provisions Let's Encrypt certs; nginx+certbot or a Cloudflare Tunnel work too), and filling in every placeholder in `.env.production.example`.

**`sync.sh`** — rsyncs local source to a remote host (respecting `.gitignore`; never touches the remote's own `.env` or `./backups`, so production secrets and backups are never overwritten by what's, or isn't, on your dev machine) and rebuilds/restarts the `backend`/`frontend` containers there:

```bash
./sync.sh user@host       # sync + rebuild (--no-cache) + restart
./sync.sh --sync-only     # sync files only, no rebuild
./sync.sh --rebuild-only  # rebuild/restart without syncing
./sync.sh --logs          # tail backend logs after deploy
```

Set `OPENCDR_REMOTE=user@host` / `OPENCDR_REMOTE_DIR=path` to avoid passing them every time. `db` and `backup` are never touched by a sync — only `backend`/`frontend` get rebuilt, so a redeploy never risks the database.

---

## Development (without containers)

```bash
# backend  (needs a local Postgres; set PGHOST etc. in backend/.env)
cd backend && npm install && npm run dev

# frontend (proxies /api to http://localhost:3001)
cd frontend && npm install && npm run dev
```

`npm run migrate` and `npm run seed` in `backend/` run those steps standalone; `npm run seed:demo` (6 months) and `npm run seed:demo:12mo` (12 months) run the rich 5,000-record generator (see [Quick start](#quick-start)).

---

## Note on the standard

The schema marks `callEndTime` as **required** on `CallRecord`, but the same field's description says its absence implies an ongoing call (`callState: ongoing`). Those can't both hold. This platform treats `callEndTime` as optional so ongoing calls can be logged — worth reconciling in a future revision of the standard (either drop it from `required`, or document that ongoing records omit it as an explicit exception).

`backend/src/data/cdr-schema.yaml` and `cdr-examples.json` are vendored copies of the standard, not live references to it — `/openapi.json` and the Swagger UI at `/docs` serve the schema file directly, and the examples file is what `npm run seed`/`seedExamples()` loads on first boot, so both need to be manually re-synced when the upstream standard changes (most recently: an optional `transcription` field on `CallRecord`, referencing a `TranscriptionInfo` object — status, method, provider, language, confidence score, word count, a PII-redaction flag, and a download path, closely mirroring `cloudRecording`'s shape — added to both the schema and the first example scenario). Keeping this platform's ingest validation (`schemas/cdr.ts`) in sync with the vendored schema is a manual step too — there's no generation from the YAML.

---

## Status

A prototype: no TLS baked in (bring your own reverse proxy — see [Deploying](#deploying)), single-node Postgres, statistics computed on the fly. Enough to ingest conforming CDRs, browse them, and demonstrate the standard end to end. A baseline hardening pass is in place (security headers, login rate limiting, non-root containers — see [Deploying](#deploying)), but this hasn't had a full production security audit.

---

## Roadmap

Not yet implemented — tracked here for now:

- **Off-host copy of backups/PITR archives** *(production-readiness)* — both `./backups` (scheduled `pg_dump`s) and MinIO's own data volume live on the same host as the database they're backing up. Neither is copied elsewhere automatically, so a full host loss (`DISASTER_RECOVERY.md`'s Scenario B) is only survivable today if *you've* separately copied a `.dump` file off-host yourself — PITR doesn't close this gap either, since MinIO's data dies with the host exactly like `./backups` does. Needs a real off-host target (another host, cloud object storage, etc.) and a sync mechanism, not just documentation.

Done:

- ~~Point-in-time recovery (WAL archiving)~~ — continuous WAL archiving via `pgBackRest` to a self-hosted MinIO (S3-compatible) target, layered on top of (not replacing) the existing `pg_dump` backups: `db` is now a custom-built image (`postgres/Dockerfile`) with `archive_mode`/`archive_command` wired to `pgbackrest archive-push`, a background loop that creates the pgBackRest stanza and takes periodic full backups, and new `minio`/`minio-init` compose services. See **[DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md)**'s new Scenario C for the restore runbook. Chosen over SFTP: neither pgBackRest nor WAL-G support SFTP at all, since continuous WAL shipping needs the ordered, retry-safe delivery an object-storage API gives for free.

  Found and fixed three real bugs the hard way, not from documentation alone: pgBackRest was connecting as the container's OS user (`root`), which has no matching Postgres role, fixed via a new `PGBACKREST_PG1_USER` env var; pgBackRest's S3 driver always speaks TLS regardless of `verify-tls` settings (that only skips certificate *verification*, not encryption), so MinIO needed to actually terminate TLS — solved with a custom `minio/Dockerfile` baking in a build-time self-signed cert (a runtime one-shot cert-gen service was tried first but broke podman-compose's pod dependency graph and hung `up -d` indefinitely, so it was replaced rather than worked around); and a UID mismatch where `stanza-create`/`backup` (running as root) and `archive_command` (running as `postgres`, since that's who Postgres itself execs it as) fought over ownership of pgBackRest's spool directory, fixed by running the background loop via `su-exec postgres` to match.

  Verified against the real running stack, not just built: confirmed `stanza-create` and an initial full backup both succeeded, confirmed the existing `pg_dump` `backup` service runs completely unaffected alongside it, then ran the actual restore drill — inserted a disposable marker record into the live database, forced a WAL switch, and restored two separate scratch volumes from the same MinIO-backed stanza: one to a target time before the insert (came back with the exact pre-insert row count, marker correctly absent), one via full WAL replay (came back with the marker present). Both scratch environments were torn down afterward; the real database was untouched throughout.
- ~~pgBackRest/PITR health surfaced in the dashboard~~ — the same Backups panel (`⋯` menu) that already warns on a stale/failed `pg_dump` now shows a second "Point-in-time recovery" status: WAL-archiving freshness (read straight from Postgres's own `pg_stat_archiver` — no pgBackRest-specific plumbing needed) and the pgBackRest base-backup loop's own success/failure, via a new `.pitr-last-attempt` marker file mirroring `pg_dump`'s existing `.last-attempt` convention. `GET /admin/backups` gained a `pitr` field carrying both, computed the same "raw facts from the backend, staleness derived client-side" way the existing pg_dump warning already works. Deliberately doesn't treat `pg_stat_archiver`'s cumulative `failed_count` as the warning trigger — a failed archive-push during every boot's `stanza-create` retry window is expected and self-heals, so only a stale `last_archived_time` (10+ minutes with no successful archive, generous against the 60s `archive_timeout`) or a failed/overdue base backup drives the red state. Verified against the real running stack, including a real failure/recovery drill: stopped the `minio` container, confirmed `pg_stat_archiver.failed_count` incremented and `last_archived_time` froze while archive-push genuinely failed (`HostConnectError: unable to get address for 'minio'`), then restarted `minio` and confirmed archiving resumed — `archived_count` advanced and `last_archived_time` moved past the last failure, on the very WAL segment that had been failing. (Postgres's archiver backs off after repeated failures on the same segment, so recovery wasn't instant — worth knowing if this is ever re-tested.)
- ~~Native TLS termination, or an explicit "always needs a reverse proxy" decision~~ — decided: this platform will not bundle TLS termination itself. Bring-your-own reverse proxy (Caddy, nginx+certbot, a Cloudflare Tunnel, etc. — see [Deploying](#deploying)) remains the permanent, intentional design for now, not an unexamined gap. Revisitable later if a true single-command production deploy becomes a priority, but not pursued today.
- ~~Secrets rotation~~ — all four secrets support a rotation window (old and new both valid at once), not just a documented runbook. `ADMIN_API_KEY`/`INGEST_API_KEY` accept a comma-separated list, so no flag-day cutover is needed. `REMOTE_SOURCE_ENC_KEY`/`MFA_ENC_KEY` gained a `_PREVIOUS` fallback (decrypt tries the current key, falls back to `_PREVIOUS`; encrypt always uses the current key, so new writes migrate forward automatically) plus a new `npm run rotate-encryption-keys` script that forces every existing row onto the current key, so a rotation actually finishes rather than staying in permanent dual-key limbo. See **[SECRETS_ROTATION.md](./SECRETS_ROTATION.md)** for the operator runbook. Verified with real rotation drills, not just the mechanism in isolation: enrolled a user's MFA *before* rotating, confirmed login still worked via fallback mid-rotation, then confirmed it **still worked after removing `_PREVIOUS` entirely** — proving the rotation script actually migrated the row rather than fallback quietly masking a stale one. Same drill repeated for a real remote-source credential. Found in passing (not something this work broke): the real `admin` account has an abandoned, unconfirmed MFA enrollment sitting in the database — harmless, and correctly swept up by the rotation script, but worth knowing about.
- ~~Observability: metrics + structured logging~~ — a new `GET /metrics` (Prometheus text-exposition format, unauthenticated like `/health`) via `prom-client`: default process metrics (CPU/memory/event-loop lag) plus `http_request_duration_seconds` (latency + error rate, labeled by method/route-*pattern*/status — not raw path, to avoid unbounded cardinality on path-param routes like `/calls/{callId}`) and `remote_poll_outcomes_total` (poll success/failure by status). All `console.*` calls (41 call sites) converted to a small hand-rolled structured (JSON) logger (`backend/src/logger.ts` — not a library; the actual need was modest enough that `pino`'s real advantage, raw throughput, doesn't matter at this app's scale), with one deliberate exception: the bootstrap-admin-password reveal stays plain text, since it's a one-time human-facing "copy this now" message, not a log stream entry. Verified against the real running stack: confirmed two requests with different `callId` values collapsed into one cardinality-safe label set rather than two; discovered `podman exec ... node -e` doesn't share the running server's in-memory metrics registry (a separate process), so verified the poll-outcome counter by creating a real throwaway remote source and triggering it over HTTP — which incidentally caught the scheduled background poller racing a manual on-demand trigger in real time, correctly recording both `fetch_error` and `skipped_locked` from genuinely different code paths.
- ~~Login hardening: account lockout + MFA~~ — per-account lockout (`login_lockouts`, keyed by the *submitted username string* so a nonexistent username locks identically to a real one — no enumeration signal) on top of the existing per-IP rate limit, plus self-service TOTP MFA (`⋯` → Security): enroll/confirm with one-time recovery codes, a two-step login (`POST /auth/login` returns `mfaRequired` + a short-lived pending token when enabled), and an admin reset for the "lost my device" case. MFA secrets are encrypted at rest via a dedicated `MFA_ENC_KEY` — deliberately separate from `REMOTE_SOURCE_ENC_KEY` so a deployment using only one doesn't need to configure a key named for the other, and rotating one doesn't force re-enrolling the other. Verified against the real running stack, not just type-checked: 5 failed attempts locked a real user even against the *correct* password on the 6th try, and locked a fake username identically; full enroll → two-step login → wrong-code-then-correct-code → recovery-code (single-use, confirmed rejected on reuse) → admin-reset flow all exercised live. Found and fixed two real bugs this way — `docker-compose.yml` wasn't passing the new env vars through to the container at all, and `otplib`'s `verify()` throws on a malformed token instead of returning `{valid: false}`, which silently broke the recovery-code fallback path until wrapped in a try/catch.
- ~~Multi-replica-safe scheduled jobs~~ — the audit-log pruner, `remote_source_rejects` pruner, and remote-source poller now claim a lease from a new `scheduled_job_locks` table (`tryClaimJob()`, `backend/src/db/jobLock.ts`) before doing real work, so only one replica actually runs a given tick — others see the claim fail and skip, no duplicate `DELETE`s or duplicate remote polls. Chosen over `pg_try_advisory_lock` specifically because advisory locks pin a pool connection for the whole job duration, which is fine for a fast prune but not for remote-source polling (can legitimately run for minutes); a lease row is a single fast upsert with the connection returned immediately, and self-heals if a replica dies mid-job (the lease just expires). Verified against two real backend instances pointed at the same database, not just by inspection: confirmed a second instance's boot-time prune claims correctly failed while the first instance's lease was still active, and fired concurrent poll requests at both instances for the same source ~25ms apart, confirming one got a real attempt and the other got the new `skipped_locked` status (surfaced as a plain, non-alarming message in the dashboard's "Poll now" flow, not an error).
- ~~Tested backup/restore drill + runbook~~ — **[DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md)** documents restore-onto-a-running-stack vs. full-host-loss procedures, a post-restore verification checklist, and known limitations (point-in-time restore only covers what's been continuously archived — see the PITR bullet above; backups aren't copied off-host automatically; no partial restore). Actually rehearsed, not just written from memory: a real backup of the live database was restored into a scratch database and the checklist run against it, confirming an exact match (row counts, migrations table, a byte-for-byte record spot-check, intact user/password-hash) while the real database was untouched throughout. Also fixed a real gap the drill surfaced: the scheduled `backup` service's failures used to only ever reach `podman logs` — `scripts/backup.sh` now writes a `.last-attempt` status marker (success or failure) that `GET /admin/backups` surfaces, and the dashboard's Backups panel now shows a warning when the last backup is overdue or its last scheduled attempt failed, instead of rendering identically to a healthy state.
- ~~Automated test suite + CI~~ — the backend has a real test suite (Vitest): the zod validation gate (`schemas/cdr.test.ts` — every vendored standard example parses, plus rejection cases for missing/invalid fields) and the ingest upsert logic (`services/ingestService.test.ts` — create, update-in-place on re-ingest, batch ingest, batch rollback-on-failure) against a real Postgres, not a mock. `.github/workflows/ci.yml` runs it on every push/PR alongside type-check + build for both backend and frontend. Deliberately scoped narrow for this first pass: no route-level/HTTP tests (would need splitting `index.ts`'s monolithic app+boot-side-effects apart first) and no frontend test coverage (still just type-check + build there, matching what was already the real gate). Run it locally with `npm test` in `backend/` — needs a real (test) Postgres pointed to via `PGHOST`/etc., same precondition `npm run dev` already has.
- ~~Reorderable + show/hide columns on the records table~~ — a **⚙ Columns** menu (top right, above the table) lets you toggle each column's visibility and move it up/down; order and visibility persist to `localStorage` (`opencdr.recordsTable.columnOrder` / `...columnHidden`), as sibling keys alongside the existing widths storage. `callId` stays locked visible, since it's the row's click target into the detail drawer; the multi-participant expand toggle (from the ANI/DNIS feature below) lives in that same always-visible cell so it keeps working regardless of where other columns get reordered to or hidden.
- ~~Tighten default column widths on the records table~~ — trimmed the `TABLE_COLUMNS` defaults to what the content actually needs (e.g. `platform`/`type`/`media` 130→100–110, `start` 150→145, `ani`/`dnis` 130→110), still individually resizable as before. Doing this surfaced a real bug in the existing width-persistence logic: it wrote the *entire* merged widths map to `localStorage` on every mount, not just columns a user had actually dragged, so any browser that had loaded the table even once had its stored blob permanently shadow every later code-level default change — the initial width tightening silently did nothing for already-visited browsers. Fixed by persisting only columns that differ from the current code defaults (so future default tweaks reach anyone who hasn't manually resized that column) and bumping the storage key to `opencdr.recordsTable.columnWidths.v2`, since old stored blobs can't be told apart from a real customization and had to be abandoned rather than migrated.
- ~~Surface ANI (caller) and DNIS (dialed number) on the records table~~ — the **Parties** count column was replaced with **ANI**/**DNIS** columns (`computeAniDnis()`, `frontend/src/App.tsx`), showing the `caller`-role participant's extension and the `callee`-role participant's extension (falling back to `callSource.huntNumber`). Records with more going on than a plain two-party pair — conferences, transfer legs, IVR/queue abandons — get a `▸`/`▾` toggle in the ANI cell: collapsed by default (just the primary ANI/DNIS pair, so the table stays scannable), expanding inserts a sub-row per extra participant (role, extension, display name, join/leave time), each still keyed to the same `callId`.
- ~~Export from the records table~~ — the **Export** button (top right of the filter bar) downloads every record matching the current filters/time window as CSV or JSON, not just the visible page.
- ~~Export from the CDR drill-down~~ — the detail drawer's **Export** button downloads the single open record as CSV or JSON.
- ~~Reporting / insights~~ — the dashboard now shows a **calls throughput** chart (hourly/daily, auto-scaled to the window), a **calls by source platform** donut, and a **top talkers** table (call count + talk time, ranked, excluding IVR/queue/voicemail), backed by three new endpoints: `GET /statistics/top-talkers`, `GET /statistics/throughput`, and `GET /statistics/by-platform`.
- ~~Records-per-page control~~ — a "Rows per page" dropdown (10/25/50/100/250) next to the pager, below the records table.
- ~~Resizable table columns~~ — drag a column's right edge to resize it; widths persist across reloads (`localStorage`), with a "Reset columns" link to restore defaults.
- ~~Expanded date-range presets~~ — a **Range** dropdown (last hour / 6 hours / 24 hours / week / 3 months / 6 months / custom) in the filter bar, with true rolling windows (`now - N`) rather than calendar-day-anchored presets, and From/To pickers that stay live and editable in every mode.
- ~~Split top talkers into Internal / External tabs~~ — the top-talkers card now has Internal/External tabs, split on whether the participant carried a `userId` (internal) vs. extension-only (external), backed by a new `scope` param on `GET /statistics/top-talkers`.
- ~~Agent handle time & queue wait time metrics/graphs~~ — the throughput card gained two more tabs, **Agent handle time** and **Queue wait time**, each with a trend chart and a ranked breakdown (agents/queues, longest first, single-call agents excluded), backed by four new endpoints: `GET /statistics/handle-time`, `GET /statistics/handle-time/by-agent`, `GET /statistics/queue-wait`, and `GET /statistics/queue-wait/by-queue`. Every tab also got an **⤢ Expand** button opening a larger popover view.
- ~~Split "Calls throughput" and "Calls by source platform" into separate tabs~~ — "Calls by source platform" is now its own tab (4 tabs total on the card) instead of sharing space inside the Calls throughput tab.
- ~~Make Top Talkers rows clickable~~ — clicking a talker sets the Participant filter to that identity and applies it (layered on top of existing filters), drilling the records table straight into their calls.
- ~~Grow the "Calls by source platform" donut to fill the available space~~ — bumped from a small fixed size to a larger one (250px in-card / 340px expanded), with the legend list dropped in favor of hover-only identification. (A fluid `preserveAspectRatio`-scaled version was tried first but caused a real layout bug — nested %-height flex chains proved unreliable in practice — so this ended up tuned fixed sizing instead, same as the other three tabs.)
- ~~Grow the "Calls throughput" chart to fill the available space~~ — taller fixed height (240px in-card / 420px expanded) now that the tab no longer shares space with the platform donut, tuned to roughly match the Top Talkers card's height rather than dynamically filling it (see note above on why dynamic fill was abandoned).
- ~~Switch "Calls by source platform" from a donut to a solid pie, with an on-hover legend underneath~~ — wedges are now filled `<path>` arcs (no ring hole), and a single legend line below the chart names the hovered wedge (id, count, share), appearing only on mouseover with a fixed-height reserved slot so it doesn't shift the layout.
- ~~Database backup & maintenance~~ — a `backup` compose service runs `scripts/backup.sh` on a loop (scheduled `pg_dump`s to `./backups`, with retention pruning), and the dashboard's header menu (**⋯**) adds the on-demand side: trigger a backup, download any recent one, or restore from an uploaded `.dump` (destructive, `window.confirm`-guarded) — all optionally gated behind `ADMIN_API_KEY`. See [Backup & maintenance](#backup--maintenance). The header menu also folds the "API docs" link in, off the always-visible row, so the header doesn't grow a new button for every admin-ish feature going forward.
- ~~Export to PDF from the expanded chart view~~ — every tab's expand modal (⤢) has an "Export PDF" button, using the browser's native print-to-PDF (a print stylesheet hides everything but the chart) rather than a new client-side dependency.
- ~~Answered-vs-unanswered overlay on "Calls throughput"~~ — the throughput chart is now a stacked bar (accent = answered/`ended`, rose = unanswered/`missed`+`abandoned`, reusing rose's existing meaning elsewhere in the app), backed by a new `GET /statistics/throughput/by-outcome` endpoint, with an inline legend and a per-bucket hover tooltip breaking out both counts.
- ~~Make Agent Handle Time / Queue Wait Time rows clickable, like Top Talkers~~ — Agent Handle Time reuses the Participant filter (same as Top Talkers); Queue Wait Time got a new `queue` filter added to `GET /calls` (matches `callSource.queueInfo`) plus a matching field in the Filters popover, so both are drill-down-clickable now.
- ~~Drill across to related call legs~~ — clicking a `parentCallId`/`relatedCallIds` entry in the detail drawer fetches and opens that leg's own record, with a **← Back** button to retrace the trail. A leg outside the caller's access scope, or one that was never separately ingested, 404s the same as a nonexistent record rather than confirming or leaking anything.
- ~~Worst-performing calls by MOS~~ — a new **Worst call quality** tab in the Insights card ranks the lowest-MOS voice calls in the window (worst first, color-coded by severity), backed by `GET /statistics/worst-mos`. Clicking a row opens that call's own detail drawer directly.
- ~~IVR traversal time graph~~ — a new **IVR time** tab mirrors Queue wait time: a trend chart plus a ranked "IVRs by average traversal time" breakdown, backed by `GET /statistics/ivr-time` and `GET /statistics/ivr-time/by-ivr`. A new `ivr` filter on `GET /calls` (matching `callSource.ivrInfo`) makes the breakdown rows drill-down-clickable, same as Queue wait time.
- ~~Audit log~~ — every query, ingest, and admin action (login/logout, user management, API keys, backup/restore) is now logged: who (or what), when, method/path, status, and record count where relevant. A single global middleware (not calls scattered through each route) guarantees coverage; failed logins are logged too, attributed to the attempted username, never the password. Admin-only viewer in the header menu (**⋯** → **Audit log**), retention configurable via `AUDIT_LOG_RETENTION_DAYS` (default 90 days). See [Audit log](#audit-log).
- ~~Default the Range picker to "Last 24 hours"~~ — the dashboard now opens on a real rolling 24-hour window instead of the fixed 2024-06-01 demo date, matching production behavior. The 2024 demo scenarios and older synthetic data stay reachable via the date pickers or wider presets.
- ~~Label participants in the Call trace~~ — each `ParticipantCard` now shows its `participantId` as a small tag, so trace events referencing `p1`/`p2`/etc. are identifiable at a glance.
- ~~Show participant username alongside display name~~ — when a participant has both, the card now reads `Display Name (username)` instead of the username disappearing once a display name is present.
- ~~Export button on the Audit log viewer~~ — the same CSV/JSON export pattern as the records table, pulling every entry matching the current filters (not just the visible page).
- ~~User accounts & scoped access~~ — session-cookie login is always required; each user has `admin`/`viewer` role and optional `allowedGroups`/`allowedSourcePlatformIds` scoping enforced server-side. See [Authentication & scoped access](#authentication--scoped-access).
- ~~A proper config/settings UI~~ — the **⋯** header menu now has real admin panels: **Users** (create/edit/delete, role/scope/password reset), **API keys** (self-service, per-user), and **Audit log** (paginated/filterable/exportable viewer). Rotating the shared `INGEST_API_KEY`/`ADMIN_API_KEY` still requires editing `.env` and restarting — those are unchanged, machine-facing secrets that per-user API keys are meant to make largely unnecessary rather than replace outright.
- ~~Advanced filter with operators~~ — a new **Advanced** field in the Filters popover accepts comma-separated numeric conditions (`mos < 3, jitter > 50`) against `qos.*`, `durationSeconds`, and `callSource.timeInIvrSeconds`/`timeInQueueSeconds`, translated server-side into parameterized SQL against a fixed field allowlist (never user-supplied SQL).
- ~~Transcription support~~ — synced the vendored schema and example scenarios with an upstream addition to the standard (`transcription`/`TranscriptionInfo` on `CallRecord`), added ingest validation, added a **Transcription** section to the detail drawer (status, method, provider, language, confidence, word count, a PII-redaction badge, download link) mirroring the existing Recording section, and the seeded example scenarios and `npm run seed:demo` generator both now include realistic transcription data. See [Note on the standard](#note-on-the-standard).
- ~~Interaction timeline popup~~ — a **⤢ Timeline** button on the detail drawer's Call trace card opens a Genesys-Cloud-style swimlane view: one row per participant, colored segments (waiting, active, on hold, wrap-up) plotted against a shared time axis, with hover tooltips. Segments are derived client-side from whatever detail a record actually has — explicit `joinTime`/`leaveTime`, participant-scoped events, IVR/queue entry-exit events, or a single honest "active" span for the sparsest records — no new endpoint or stored data needed.
- ~~Search by call/interaction ID~~ — a **Call ID** field (in the Filters popover) does an exact `GET /calls/{callId}` lookup and opens the record directly, bypassing whatever date range/filters are currently active — a jump-to-record action rather than a table filter.
- ~~Surface event `metadata` in the Call trace~~ — a small "i" button appears next to Call trace events that carry `metadata` (DTMF digit + IVR menu, queue position, transfer reason, selected IVR option, etc.), popping open a key/value view of the raw data via a new reusable `KeyValuePopover` component.
- ~~Surface participant device data~~ — a matching "i" button on `ParticipantCard` reveals `deviceId`/`model`/`softwareVersion`/`macAddress`/`videoCodec` when present (reusing the same `KeyValuePopover`); `audioCodec`/`ipAddress` stay as the existing inline chips since they were already visible.
- ~~Display `interactionStartTime`/`interactionEndTime`~~ — the Timing section and the Interaction Timeline modal header now show the interaction-level span, but only when it actually differs from the leg's own `callStartTime`/`callEndTime`, so single-leg calls don't get redundant duplicate fields.
- ~~Surface `vendorSpecificFields`~~ — a new "Platform extensions" section at the end of the detail drawer (shown only when non-empty) with an "i" button popping open whatever's in the object, reusing the same `KeyValuePopover`/`InfoButton` components as the event-metadata and device-info buttons above.
- ~~Fix supervisor `joinTime` in the monitor/barge demo scenario~~ — barge-in records now set the supervisor's `joinTime` to their actual `barge_in` moment instead of the call start, so they render as present only from when they actually joined. Silent-monitor records (no barge-in moment) are unaffected.
- ~~Ingest CDR records from a remote Open-CDR-compatible source~~ — admin-managed remote sources (**⋯** → **Remote sources**), each pulled on its own schedule via an in-process poller (no separate compose service needed, same reasoning as the audit-log pruner). Supports both a static API key and OAuth2 client-credentials (token fetched, cached in-process, and refreshed near expiry); credentials are encrypted at rest (`REMOTE_SOURCE_ENC_KEY`, AES-256-GCM) and never round-tripped back to the client once saved, matching how every other machine credential in this app is handled. Every pulled record is validated one at a time against the same `callRecordSchema` gate pushed ingest uses — a record that doesn't fully conform is rejected and logged to a per-source reject history (viewable in the panel) rather than blocking the rest of that page. A per-source watermark tracks progress so re-polling never reprocesses the whole window; a failed poll leaves the watermark untouched so the next cycle safely re-covers it, since ingest is idempotent by `callId`. See [Deploying](#deploying) for the new `REMOTE_SOURCE_ENC_KEY`/`REMOTE_SOURCE_REJECTS_RETENTION_DAYS` env vars.
- ~~"Custom" remote source type — user-scripted mapping~~ — a third source type: an admin writes a Python script (stored in `remote_sources.auth_config`, same encrypted-JSONB approach as the other two types), which the backend runs in-container on the same poll schedule. The script owns the whole pull — connect to whatever the remote actually is, scan since a `WATERMARK` env var, parse, map to `CallRecord` shape — and prints `{"records": [...], "watermark": "..."}` to stdout; the backend validates each record through the exact same per-record gate/reject pipeline the other two source types use. Sandboxing is deliberately coarse, not a security boundary: runs as the backend's existing non-root user (free, not root like the `walkthenxtfloor` prior art), a wall-clock timeout with a `SIGKILL` escalation if `SIGTERM` is ignored, a memory ceiling, and a stdout size cap independent of that memory ceiling (protects the *parent* Node process from a runaway script's output, which the child-process memory limit doesn't). The UI requires an explicit acknowledgement checkbox before saving a script, since this platform runs it as submitted. Found via testing, not by inspection: a never-polled source could get picked up by both the 60s background scheduler and an on-demand "Poll now" click in the same window, running two fully concurrent executions (and kept accumulating another pair every further tick, since a source looks "due" until its first poll completes) — harmless for the idempotent HTTP source types beyond wasted work, but a real problem for a script with non-idempotent side effects (e.g. deleting files off an SFTP server once processed). Fixed with a per-source in-process lock (`remotePollService.ts`): a caller that arrives while a poll for that source is already running gets the same in-flight result instead of starting a second execution — verified live with two requests firing 3ms apart, both correctly waiting on and receiving the identical result of one single execution. The script textarea also has an **Example scripts** button opening a popup of four starting-point templates (`EXAMPLE_SCRIPTS`, `frontend/src/App.tsx`) — a minimal contract-only template, a generic HTTP JSON API puller and a CSV-over-HTTP puller (both stdlib-only), and an SFTP file-scan example matching the CUCM/SFTP flow this feature exists for. The SFTP example needs `paramiko`, which isn't part of a stock Python install — bundled into the backend image specifically so that flagship example actually runs rather than failing with `ModuleNotFoundError` the moment someone tries it.

---

## License

This platform is licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE) — free for noncommercial use, source-available otherwise. This is separate from the Open CDR Standard itself, which is Apache 2.0 licensed.
