# Open CDR Platform

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
- **db** — PostgreSQL 16 (named volume `pgdata`)
- **backup** — scheduled `pg_dump`s to `./backups` on the host; see [Backup & maintenance](#backup--maintenance)

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
  migrations/    sequential SQL (001 table, 002 indexes, 003+ backfills, 005 users/sessions, 006 API keys, 007 audit log)
  schemas/       zod mirror of the standard — the ingest gatekeeper
  services/      ingest, read (list/get), statistics, auth (users/sessions/API keys), audit log, advanced filter parsing
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

**Scheduled** — the `backup` compose service (plain `postgres:16-alpine`, which already ships `pg_dump`/`pg_restore`) runs `scripts/backup.sh` on a loop: dump on start, sleep `BACKUP_INTERVAL_HOURS` (default `24`), repeat. Dumps land in `./backups` on the host as `opencdr-<UTC timestamp>.dump` (custom pg_dump format, compressed), and each run prunes dumps older than `BACKUP_RETENTION_DAYS` (default `14`). Both are set in `.env`.

**On-demand, from the dashboard** — the header menu (**⋯**, top right) has a full Backups panel: last-backup time and retention summary, a scrollable list of recent dumps with a **⬇ download** action each, a **Backup now** button, and a **Restore…** button (pick a `.dump` file, confirm, and it replaces the database outright via `pg_restore --clean --if-exists`). The backend carries its own `pg_dump`/`pg_restore` (installed from the versioned PGDG apt repo — Debian's default package is v15, and pg_dump refuses to dump a *newer* server than itself, so it has to match the v16 server) and mounts `./backups` read-write, alongside the scheduled service.

**On-demand, from the API** — same three actions: `POST /admin/backups` (trigger), `GET /admin/backups/{filename}/download`, `POST /admin/backups/restore` (body is the raw `.dump` file). `GET /admin/backups` (the list) just needs a logged-in session, like the rest of the read API; the three action endpoints above additionally accept `ADMIN_API_KEY` (`X-API-Key` header) as an alternative to a logged-in admin session — unset by default (fine for a local lab), **strongly recommended once this is reachable beyond one**, since restore has no undo.

**Manual, from the CLI** — the `backup` service's entrypoint is the loop itself, so a one-off run needs `--entrypoint` to invoke a script directly instead:

```bash
# Backup now
podman-compose run --rm --entrypoint sh backup /scripts/backup.sh

# Restore a dump (drops and recreates conflicting objects — --clean --if-exists)
podman-compose run --rm --entrypoint sh backup /scripts/restore.sh /backups/opencdr-<stamp>.dump
```

Routine maintenance beyond backups (autovacuum, index bloat, etc.) is handled by Postgres's own defaults, which are on out of the box in the `postgres:16-alpine` image — nothing extra configured here.

---

## Deploying

`.env.example`'s defaults are intentionally open for a local lab (no auth on ingest, no TLS). For anything reachable beyond your own machine, start from `.env.production.example` instead — it documents which values are *required* (`INGEST_API_KEY`, `ADMIN_API_KEY`, a real `PGPASSWORD`, `BOOTSTRAP_ADMIN_PASSWORD`) and which need a TLS-terminating reverse proxy in front before it's safe to flip (`COOKIE_SECURE`).

Already in place regardless of which `.env` you use:

- `helmet` security headers (HSTS, `X-Content-Type-Options`, `X-Frame-Options`, hides `X-Powered-By`, etc.) — CSP is deliberately left off, since Swagger UI's bundled `/docs` relies on inline scripts and a hand-tuned CSP for one page isn't worth it here.
- Rate limiting on `POST /auth/login` (20 attempts / 15 min per IP), alongside the existing higher-volume limiter on `POST /calls/ingest`.
- `trust proxy` set for one reverse-proxy hop, so the audit log and both rate limiters resolve the real client IP once a proxy sits in front, instead of the proxy's own address.
- The backend container runs as a non-root user. `docker-entrypoint.sh` fixes up the `./backups` bind mount's ownership at container start rather than at build time — a build-time `chown` alone isn't enough under rootless Podman's default UID namespace remapping, where the image's `node` user and the host account can both report uid 1000 without actually being the same identity.
- `CORS_ORIGIN` is configurable (defaults to `*`, fine for a local lab) — pin it to your real origin once deployed, as defense in depth. Session auth doesn't depend on this either way, since cookies aren't sent cross-origin regardless (not configured with `credentials: true`).

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

- **Clearer indication when filters are applied** *(low priority — current badge indicator judged adequate for now)* — the Filters button already shows a count badge for groups/source platform/participant, but media type and a non-default date range give no visual signal outside their own controls. Worth a more visible summary (e.g. a chip row of active filters) so it's obvious at a glance the table isn't showing the full unfiltered window.
- **Ingest CDR records from a remote Open-CDR-compatible source** *(new, multi-part feature)* — pull records from another platform's own `GET /calls` API rather than only ever receiving pushed ingest. Auth mechanism is flexible/negotiable at implementation time: either OAuth2 client-credentials with a preconfigured `clientId`/`clientSecret` (the vendored standard's own `securitySchemes.OAuth2` already defines a `clientCredentials` flow against a `tokenUrl`, scoped to `cdr:read`/`cdr:stats`), or a simpler bearer API key (matching this platform's own existing `requireApiKey` pattern) if that proves easier to implement against real remote sources. Likely breaks down into:
  - **Remote source config** — admin-managed record of a remote source's base URL plus whichever credential shape it needs (`clientId`/`clientSecret`+`tokenUrl`, or a single API key), with secrets handled the same way other machine credentials in this app are (never round-tripped back to the client once saved).
  - **Auth** — either fetch-and-cache a bearer token (refreshed before expiry) via client-credentials, or attach a static API key — against the remote's `GET /calls`.
  - **Scheduled/on-demand pull** — a polling job (cron-style, similar to the existing `backup` compose service's loop) that pages through the remote's `GET /calls` for a rolling window and imports new/updated records, tracking a watermark per source so re-polling doesn't reprocess everything.
  - **Strict validation gate** — every fetched record must pass the exact same `callRecordSchema` gate as pushed ingest before being stored; per the "100% expected JSON results" requirement, a record that doesn't fully conform gets rejected and logged, not coerced or partially stored.

Done:

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

Licensed Apache 2.0, matching the standard.
