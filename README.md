# Open CDR Platform

A reference **call-logging platform** for the [Open CDR Standard](./backend/src/data/cdr-schema.yaml) — the vendor-neutral Call Detail Record schema. It ingests CDRs written to the standard, stores them, and serves the standard's read API (list, fetch, statistics, health) plus a dashboard for browsing calls, participants, and event timelines.

It's the "open call-logging platform for ingesting CDR data" described as future work in the standard, built as a runnable prototype.

Stack and structure deliberately mirror the Aggre/Gator event-aggregator: Node + Express + TypeScript + PostgreSQL on the backend (zod validation, `pg` pool, sequential SQL migrations, Swagger UI), React 18 + Vite on the frontend, deployed via compose.

---

## Quick start

```bash
cp .env.example .env      # adjust credentials if you like
podman-compose up --build # or:  docker compose up --build
```

Then open the dashboard at **http://localhost:8080**.

On first boot the backend runs migrations and seeds the five example scenarios from the standard (simple inbound, IVR/ACD queue, outbound, conference, transfer), so the dashboard has data immediately. The default time window covers those samples (2024-06-01).

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

`GET /calls` supports the standard's documented parameters: `startTime` and `endTime` (both required, UTC ISO-8601), `mediaType` (comma-delimited), `groups` / `excludeGroups` (comma-delimited), `page`, `pageSize` (max 1000), and the `X-Tenant-Id` header. Records are ordered by `lastUpdateTime` (falling back to `endTime`, then `startTime`) ascending. Platform extensions on top: `sourcePlatformId` (comma-delimited), `participant` (matches `participantId`/`userId`/`displayName`/`extension`), `queue` (matches `callSource.queueInfo`, comma-delimited), and `ivr` (matches `callSource.ivrInfo`, comma-delimited).

All of the above except `/health`, `/openapi.json`, `/docs`, and `POST /calls/ingest` require a logged-in session — see [Authentication & scoped access](#authentication--scoped-access).

The `/statistics/*` insights endpoints share `startTime`/`endTime`, `mediaType`, `groups`/`excludeGroups`, `sourcePlatformId`, and `X-Tenant-Id` with `GET /calls`. `top-talkers`, `by-agent`/`by-queue`/`by-ivr` breakdowns, and `worst-mos` also take `limit` (default 10, max 50); the trend endpoints (`throughput`, `handle-time`, `queue-wait`, `ivr-time`) take `bucket` (`hour` | `day`, default `day`). `top-talkers` and `handle-time/by-agent` exclude system-component roles (`ivr`/`queue`/`voicemail`/`unknown`) so they reflect people, not routing components. `worst-mos` only considers calls with a `qos.mosScore` present (voice calls with QoS reporting), ordered ascending (worst quality first).

### Ingesting records

The standard defines a read-only API, so ingestion is a platform extension. Every record is validated against the standard before it is stored — out-of-vocabulary enum values or missing required fields are rejected with a 400, so the store only ever holds conforming records. Records are upserted by `callId`.

```bash
curl -X POST http://localhost:8080/api/cdr/v1/calls/ingest \
  -H "Content-Type: application/json" \
  -d @my-call.json
```

To require auth, set `INGEST_API_KEY` in `.env`; clients then send `X-API-Key: <key>`. Left blank, ingest is open (fine for a local lab). The dashboard's **Ingest records** button posts JSON straight to this endpoint.

---

## Authentication & scoped access

Logging in is always required — there's no open mode for the dashboard or the read API (`GET /calls`, `GET /calls/{callId}`, `/statistics/*`, `GET /admin/backups`). `POST /calls/ingest` is the one exception: it's machine-to-machine (a switch/connector posting records), so it keeps its own separate `INGEST_API_KEY` gate rather than requiring a person to log in.

**Login** is a username/password form (dashboard's `LoginScreen`, or `POST /auth/login` directly) that sets an `httpOnly` session cookie — no tokens for frontend JS to manage. Sessions are DB-backed (a `sessions` table, 7-day expiry), so logout (`POST /auth/logout`) and deleting a user immediately and fully invalidate their session, unlike a stateless signed token. The cookie is `sameSite: Lax` and non-`Secure` by default, since the stack runs over plain HTTP by default (see [Status](#status)) and browsers silently drop `Secure` cookies over non-HTTPS; set `COOKIE_SECURE=true` in `.env` only once this is actually served behind TLS.

**Bootstrap admin** — on first boot, if the `users` table is empty, one admin account is created from `BOOTSTRAP_ADMIN_USERNAME` (default `admin`) / `BOOTSTRAP_ADMIN_PASSWORD`. Leave the password blank and one is generated and printed once to the backend's startup logs (`podman-compose logs backend` / `docker compose logs backend`) — save it from there, it isn't stored anywhere else in recoverable form.

**Managing users** — admin-only, via the dashboard's header menu (**⋯** → **Users**): add a user (username, password, role, optional scope), or delete one. Each user is `admin` or `viewer`; only admins see the Users panel or can manage backups/restore. `PATCH /admin/users/{id}` exists for scripted use (e.g. changing scope or resetting a password) but isn't wired into the UI yet.

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
  db/            pg pool, migration runner, example seeder, bootstrap admin seeder
  migrations/    sequential SQL (001 table, 002 indexes, 003+ backfills, 005 users/sessions, 006 API keys, 007 audit log)
  schemas/       zod mirror of the standard — the ingest gatekeeper
  services/      ingest, read (list/get), statistics, auth (users/sessions/API keys), audit log
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

## Development (without containers)

```bash
# backend  (needs a local Postgres; set PGHOST etc. in backend/.env)
cd backend && npm install && npm run dev

# frontend (proxies /api to http://localhost:3001)
cd frontend && npm install && npm run dev
```

`npm run migrate` and `npm run seed` in `backend/` run those steps standalone.

---

## Note on the standard

The schema marks `callEndTime` as **required** on `CallRecord`, but the same field's description says its absence implies an ongoing call (`callState: ongoing`). Those can't both hold. This platform treats `callEndTime` as optional so ongoing calls can be logged — worth reconciling in a future revision of the standard (either drop it from `required`, or document that ongoing records omit it as an explicit exception).

---

## Status

A prototype: no TLS, single-node Postgres, statistics computed on the fly. Enough to ingest conforming CDRs, browse them, and demonstrate the standard end to end — not production-hardened.

---

## Roadmap

Not yet implemented — tracked here for now:

- **User accounts & scoped access** — authenticate dashboard/API users and restrict which `sourcePlatformId`s and `groups` each user can see records for, rather than the current all-or-nothing access.
- **A proper config/settings UI** — the **⋯** header menu works for a couple of peripheral items (docs link, backups) but won't scale as a real admin surface. Once user accounts exist, this is where they'd be managed — creating/removing users, scoping their `sourcePlatformId`/`groups` access, and managing API keys (rotating `INGEST_API_KEY`/`ADMIN_API_KEY`, or moving to per-user keys instead of the current shared ones) — rather than editing `.env` and restarting the stack by hand.
- **Clearer indication when filters are applied** *(low priority — current badge indicator judged adequate for now)* — the Filters button already shows a count badge for groups/source platform/participant, but media type and a non-default date range give no visual signal outside their own controls. Worth a more visible summary (e.g. a chip row of active filters) so it's obvious at a glance the table isn't showing the full unfiltered window.
- **Advanced filter with operators** — a filter input that takes expressions like `mos < 3`, `jitter > 50`, `duration > 300`, rather than only the fixed set of dropdown/text filters in the Filters popover. Needs a small expression grammar (field, operator, value) parsed client- or server-side and translated into the existing `GET /calls` query, plus deciding which fields are queryable this way (`qos.*`, `durationSeconds`, `callSource.timeInIvrSeconds`/`timeInQueueSeconds` are the obvious candidates).

Done:

- ~~Export from the records table~~ — the **Export** button (top right of the filter bar) downloads every record matching the current filters/time window as CSV or JSON, not just the visible page.
- ~~Export from the CDR drill-down~~ — the detail drawer's **Export** button downloads the single open record as CSV or JSON.
- ~~Reporting / insights~~ — the dashboard now shows a **calls throughput** chart (hourly/daily, auto-scaled to the window), a **calls by source platform** donut, and a **top talkers** table (call count + talk time, ranked, excluding IVR/queue/voicemail), backed by three new endpoints: `GET /statistics/top-talkers`, `GET /statistics/throughput`, and `GET /statistics/by-platform`.
- ~~Records-per-page control~~ — a "Rows per page" dropdown (10/25/50/100/250) next to the pager, below the records table.
- ~~Resizable table columns~~ — drag a column's right edge to resize it; widths persist across reloads (`localStorage`), with a "Reset columns" link to restore defaults.
- ~~Expanded date-range presets~~ — a **Range** dropdown (last hour / 6 hours / 24 hours / week / 3 months / 6 months / custom) in the filter bar, with true rolling windows (`now - N`) rather than Aggre/Gator's calendar-day-anchored presets, and From/To pickers that stay live and editable in every mode (Aggre/Gator's "custom" option has no date picker actually wired up).
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

Licensed Apache 2.0, matching the standard.
