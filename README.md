# CallOwl

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](./LICENSE)

A reference **call-logging platform** for the [Open CDR Standard](./backend/src/data/cdr-schema.yaml) — the vendor-neutral Call Detail Record schema. It ingests CDRs written to the standard, stores them, and serves the standard's read API (list, fetch, statistics, health) plus a dashboard for browsing calls, participants, and event timelines.

It's the "open call-logging platform for ingesting CDR data" described as future work in the standard, built as a runnable prototype.

**Stack**: Node/Express/TypeScript + PostgreSQL (zod validation, `pg` pool, sequential SQL migrations, Swagger UI) on the backend; React 18 + Vite on the frontend; deployed via compose.

---

## Quick start

```bash
cp .env.example .env      # adjust credentials if you like
podman-compose up --build # or:  docker compose up --build
```

- Dashboard: **https://localhost:8443** (plain `http://localhost:8080` redirects there). TLS is on by default — self-signed out of the box, so your browser warns once until you trust it or mount a real cert/key (see [Deploying](#deploying)).
- First boot runs migrations and seeds the standard's five example scenarios (inbound, IVR/ACD queue, outbound, conference, transfer), so the dashboard has data immediately. Default time window covers those samples (2024-06-01).
- For a fuller demo — enough volume for the Insights charts, drill-across, and advanced filter to show something: `npm run seed:demo` from `backend/`. Generates 5,000 schema-conformant records over the last 6 months (multi-leg transfers, conferences, IVR/queue routing, QoS metrics, monitor/barge-in, recordings/transcriptions, device info, vendor-specific fields — every field in the standard, not just the common ones), each validated before ingest. Manual/opt-in, meant for demoing/load-testing — never runs on boot.
- For a full year instead (e.g. to exercise wider Range presets or show seasonality): `npm run seed:demo:12mo` — same generator, 12 months instead of 6, tagged `demo12mo-` instead of `demo5k-` so the two batches stay independently identifiable. Both additive, safe to run alongside each other.

Services:

- **frontend** — nginx serving the built React app, terminating HTTPS (self-signed by default, named volume `certs`) and reverse-proxying `/api` to the backend; host ports `8080` (HTTP, redirects to HTTPS) and `8443` (HTTPS)
- **backend** — the Express API on port `3001`
- **db** — PostgreSQL 16, custom-built with `pgBackRest` for continuous WAL archiving (named volume `pgdata`)
- **backup** — scheduled `pg_dump`s to `./backups` on the host; see [Backup & maintenance](#backup--maintenance)
- **minio** / **minio-init** — self-hosted S3-compatible object storage, the `pgBackRest` archiving target for point-in-time recovery; internal-only, no host port (named volume `miniodata`)
- **offsite-backup** — opt-in off-host copy of both backup artifacts to a separate S3-compatible target; idle until `OFFSITE_S3_ENDPOINT` is set. See [Backup & maintenance](#backup--maintenance)

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
| `POST` | `/admin/backups` | **Platform extension** — trigger a `pg_dump` now (requires a logged-in admin session, or `ADMIN_API_KEY`) |
| `GET` | `/admin/backups/{filename}/download` | **Platform extension** — download a backup file (same auth as above) |
| `POST` | `/admin/backups/restore` | **Platform extension** — restore from an uploaded `.dump` file (same auth as above, destructive) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/admin/users` | **Platform extension**, admin-only — manage dashboard/API user accounts (see [Authentication & scoped access](#authentication--scoped-access)) |
| `GET` | `/admin/audit-log` | **Platform extension**, admin-only — who queried/ingested/administered what (see [Audit log](#audit-log)) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/admin/remote-sources` | **Platform extension**, admin-only — configure remote Open-CDR sources to pull from |
| `POST` | `/admin/remote-sources/{id}/poll` | **Platform extension**, admin-only — trigger a pull from that source now |
| `GET` | `/admin/remote-sources/{id}/rejects` | **Platform extension**, admin-only — pulled records that failed validation, paginated |
| `POST` | `/auth/login` | **Platform extension** — username/password login, sets a session cookie |
| `POST` | `/auth/logout` | **Platform extension** — invalidates the current session |
| `GET` | `/auth/me` | **Platform extension** — the logged-in user, or `401` |
| `GET`/`POST`/`DELETE` | `/auth/api-keys` | **Platform extension**, self-service — manage your own API keys (see [Authentication & scoped access](#authentication--scoped-access)) |
| `GET` | `/health` | Health + version probe (unauthenticated) |
| `POST` | `/calls/ingest` | **Platform extension** — ingest one record or an array (`INGEST_API_KEY` or a per-user API key) |

**`GET /calls` filters:**

- Standard: `startTime`/`endTime` (required, ISO-8601), `mediaType`, `groups`/`excludeGroups`, `page`, `pageSize` (max 1000), `X-Tenant-Id` header. Sorted by `lastUpdateTime` → `endTime` → `startTime`, ascending.
- Extensions: `sourcePlatformId`, `participant` (id/userId/displayName/extension), `queue` (`callSource.queueInfo`), `ivr` (`callSource.ivrInfo`).
- `advanced` — numeric conditions, e.g. `advanced=mos < 3, jitter > 50` (comma-separated, ANDed). Fields: `mos`/`jitter`/`latency`/`packetLoss` (`qos`), `duration`, `ivrTime`/`queueTime`. Operators: `< <= > >= = !=`. Fixed server-side allowlist — unknown/malformed clauses reject with `400`, never interpolated into SQL. Dashboard: Filters popover's **Advanced** field.

All endpoints except `/health`, `/openapi.json`, `/docs`, `POST /calls/ingest` require login — see [Authentication & scoped access](#authentication--scoped-access).

**`/statistics/*`** share `startTime`/`endTime`, `mediaType`, `groups`/`excludeGroups`, `sourcePlatformId`, `X-Tenant-Id` with `GET /calls`.
- Ranking endpoints (`top-talkers`, `by-agent`/`by-queue`/`by-ivr`, `worst-mos`): `limit` (default 10, max 50).
- Trend endpoints (`throughput`, `handle-time`, `queue-wait`, `ivr-time`): `bucket` (`hour`|`day`, default `day`).
- `top-talkers`/`handle-time/by-agent` exclude system roles (ivr/queue/voicemail/unknown) — people only. `worst-mos` needs `qos.mosScore` present, worst first.

### Ingesting records

- Read-only per the standard, so ingestion is a platform extension. Every record is validated before storage — out-of-vocabulary enums or missing required fields are rejected with a 400, so the store only ever holds conforming records. Upserted by `callId`.
- ```bash
  # -k: the default self-signed cert isn't trusted by curl either — drop it
  # once you've replaced the cert with a real one (see Deploying).
  curl -k -X POST https://localhost:8443/api/cdr/v1/calls/ingest \
    -H "Content-Type: application/json" \
    -d @my-call.json
  ```
- Auth: set `INGEST_API_KEY` in `.env` to require `X-API-Key: <key>`; blank = open (fine for a local lab). A per-user API key also works (see [Authentication & scoped access](#authentication--scoped-access)). Dashboard's **Ingest records** button posts JSON straight to this endpoint.

---

## Authentication & scoped access

- Login required everywhere except `POST /calls/ingest` (machine-to-machine, own `INGEST_API_KEY` gate).
- **Login**: `LoginScreen` or `POST /auth/login` → `httpOnly` session cookie, DB-backed (`sessions`, 7-day expiry) so logout/user-deletion invalidate it immediately. `sameSite: Lax`, `Secure` by default (containerized stack always has real TLS); `npm run dev` needs `COOKIE_SECURE=false`.
- **Bootstrap admin**: first boot, if `users` is empty, creates one from `BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD`. Blank password → generated, printed once to backend logs.
- **Managing users**: admin-only, **⋯ → Users** — add/edit/delete, role (`admin`/`viewer`), optional scope. Demoting your own account asks for confirmation.
- **Scoped access**: `allowedGroups`/`allowedSourcePlatformIds` per user (`null` = unrestricted). Reads intersect with scope, never widen it; out-of-scope requests return zero rows, not an error.
- Scope does **not** apply to ingest — any valid credential can ingest into any group/tenant. Same trust model as the shared `INGEST_API_KEY`; no per-account write restriction today.
- **Key-based auth unchanged**: `ADMIN_API_KEY`/`INGEST_API_KEY` still work; an admin session is also accepted for `ADMIN_API_KEY`-gated actions.
- **Per-user API keys**: **⋯ → API keys** — named, revocable, act as their owner (same role/scope). Use as `X-API-Key` for reads or ingest. Shown once at creation; deleting a user cascades to their keys.

---

## Audit log

- Logged automatically (`backend/src/middleware/audit.ts`, one global middleware — no route can end up unaudited): who, when, method/path, status, record count where cheap (`GET /calls`, `POST /calls/ingest`). Covers queries, ingest, and admin actions (login/logout incl. failures, user/key management, backup/restore). Excluded: `/health`, `/openapi.json`, `/docs`, `GET /auth/me`.
- Actor: `user` (session or key), `ingest_key`/`admin_key` (shared secrets), or `anonymous`. Failed logins log the attempted username, never the password.
- **Viewing**: admin-only, **⋯ → Audit log** — paginated, filterable (actor, method, path prefix, date range). Retained `AUDIT_LOG_RETENTION_DAYS` (default `90`), pruned on boot and daily.

---

## How it's stored

- One table, `call_records`. The full spec-compliant CallRecord is kept verbatim in a JSONB `record` column, so responses are faithful to the standard byte-for-byte. A handful of scalar columns are projected from the record at ingest time purely to make the documented filters fast/indexable: time fields, `call_state`, `media_type`, `tenant_id`, and a denormalised `groups` array (distinct `participants[].group` values, for array-overlap filtering). Statistics derive from these plus `callSource` routing fields.

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

- **Scheduled**: `backup` service loops `scripts/backup.sh` — dump, sleep `BACKUP_INTERVAL_HOURS` (default 24), repeat. Lands in `./backups` (`callowl-<UTC timestamp>.dump`), pruned past `BACKUP_RETENTION_DAYS` (default 14). `.last-attempt` marker → dashboard warning if overdue/failed.
- **Dashboard**: **⋯** → Backups — status, download, **Backup now**, **Restore…** (`.dump` upload, `pg_restore --clean --if-exists`).
- **API**: `POST /admin/backups` (trigger), `GET /admin/backups/{filename}/download`, `POST /admin/backups/restore`. Listing needs a session; actions need an admin session or `ADMIN_API_KEY` — recommended once reachable beyond one, since restore has no undo.
- **CLI**:
  ```bash
  podman-compose run --rm --entrypoint sh backup /scripts/backup.sh
  podman-compose run --rm --entrypoint sh backup /scripts/restore.sh /backups/callowl-<stamp>.dump
  ```
- **PITR**: `db` continuously archives WAL via `pgBackRest` to self-hosted MinIO, plus a full base backup every `PITR_BACKUP_INTERVAL_HOURS` (default 24) — restores to any point, not just a dump's exact moment. See **[DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md)** Scenario C; health surfaces in the Backups panel.
- **Off-host copy**: `offsite-backup` mirrors `./backups` + MinIO's PITR data to a separate S3-compatible bucket (`OFFSITE_SYNC_INTERVAL_HOURS`, default 24) once `OFFSITE_S3_*` vars are set; idles otherwise.
- **Incident recovery**: see **[DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md)** — procedures, verification checklist, known limitations. Rehearsed against a scratch database.
- Routine maintenance (autovacuum etc.) uses Postgres's defaults — nothing extra configured.

---

## Deploying

- `.env.example` is open by default (local lab: no ingest auth, self-signed TLS). For anything reachable beyond your own machine, start from `.env.production.example` — documents required values (`INGEST_API_KEY`, `ADMIN_API_KEY`, real `PGPASSWORD`, `BOOTSTRAP_ADMIN_PASSWORD`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`).
- **TLS** on by default — `frontend` terminates HTTPS, self-signed cert persisted in a `certs` volume; `HTTP_PORT` (8080) only redirects to `HTTPS_PORT` (8443). For a trusted cert: front it with a reverse proxy (Caddy/nginx+certbot/Cloudflare Tunnel), mount `server.crt`/`server.key` over `/etc/nginx/certs`, or upload one via **⋯ → TLS certificate** (admin only). `COOKIE_SECURE` stays safe either way — transport is always real TLS.
- **Cert upload flow**: `GET/POST /admin/tls` validates and stages the pair; `frontend/cert-watcher.sh` picks it up, `nginx -t`, reloads or rolls back, reports via `.cert-reload-status`. Same auth as backup restore.

**Already in place:**

- `helmet` security headers (CSP off — Swagger UI's `/docs` needs inline scripts)
- Rate limiting: 20/15min/IP on login, generous limiter on ingest
- `trust proxy` (one hop) so audit log/rate limiters see the real client IP
- Backend runs non-root; `docker-entrypoint.sh` fixes `./backups` ownership at container start (rootless Podman UID remapping)
- `CORS_ORIGIN` configurable (default `*`) — pin to your real origin as defense in depth

**Conditional secrets:**

- `REMOTE_SOURCE_ENC_KEY` (32-byte base64) — required once a remote source is configured, else 501. `REMOTE_SOURCE_REJECTS_RETENTION_DAYS` (default 90).
- `MFA_ENC_KEY` (same format) — required once MFA is enabled, else 501.

**Outbound alerting**: `ALERT_WEBHOOK_URL` (e.g. Slack) notifies on backup/PITR/off-host/remote-source health flips. `ALERT_COOLDOWN_HOURS` (default 6), `ALERT_CHECK_INTERVAL_MINUTES` (default 5). Unset → checks run, never post.

**Rotating secrets** (`ADMIN_API_KEY`, `INGEST_API_KEY`, `REMOTE_SOURCE_ENC_KEY`, `MFA_ENC_KEY`): see **[SECRETS_ROTATION.md](./SECRETS_ROTATION.md)** — all four support an old+new rotation window.

Still manual: filling in `.env.production.example`'s placeholders, including `OFFSITE_S3_*` (see [Backup & maintenance](#backup--maintenance)).

**`sync.sh`** — rsyncs to a remote host (never touches remote `.env`/`./backups`) and rebuilds/restarts `backend`/`frontend`:

```bash
./sync.sh user@host       # sync + rebuild (--no-cache) + restart
./sync.sh --sync-only     # sync files only, no rebuild
./sync.sh --rebuild-only  # rebuild/restart without syncing
./sync.sh --logs          # tail backend logs after deploy
```

Set `OPENCDR_REMOTE=user@host` / `OPENCDR_REMOTE_DIR=path` to avoid passing them every time. `db` and `backup` are never touched by a sync — only `backend`/`frontend` get rebuilt.

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

- `callEndTime` is marked **required**, but its description says absence implies an ongoing call — contradictory. Treated as optional here so ongoing calls can be logged, pending an upstream fix.
- `cdr-schema.yaml`/`cdr-examples.json` are vendored copies, not live references — served/seeded directly, and re-synced manually when the standard changes. `schemas/cdr.ts` is kept in sync by hand too; nothing generates one from the other.

---

## Status

- Past prototype stage: HTTPS by default, MFA, login lockout, encrypted-at-rest secrets with rotation, PITR + off-host backup sync, outbound alerting, a full audit log, a real (if narrow) test suite.
- Still: single-node Postgres, stats computed on the fly, baseline (not full) hardening — no production security audit yet. See [Deploying](#deploying).

---

## License

This platform is licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE) — free for noncommercial use, source-available otherwise. This is separate from the Open CDR Standard itself, which is Apache 2.0 licensed.
