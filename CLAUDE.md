# CLAUDE.md

Guidance for Claude Code working in this repo. For what the platform *is* and does, see [README.md](./README.md) — this file is about how to work in the codebase, not what it does.

## Stack

Node/Express/TypeScript + PostgreSQL backend (zod validation, `pg` pool, sequential SQL migrations), React 18 + Vite frontend (no router, no external UI/chart library — everything hand-rolled in `frontend/src/App.tsx` with inline styles), deployed via `podman-compose`/`docker compose`.

## Running it

```bash
cp .env.example .env
podman-compose up --build   # or: docker compose up --build
```

Dashboard at `http://localhost:${HTTP_PORT}` (default 8080). `backend/` has no committed `.env` — for local dev without containers, set `PGHOST` etc. directly (see README's "Development" section).

## Making a change: the loop that actually works here

1. Edit backend TS under `backend/src/`, frontend TS under `frontend/src/`.
2. Type-check both before touching containers:
   ```bash
   cd backend && npx tsc --noEmit
   cd frontend && npx tsc --noEmit -p tsconfig.json
   ```
   The frontend currently has pre-existing, harmless `tsc` noise on `ListParams`/`InsightsParams`/`AuditLogParams` (a structural-typing mismatch with the generic `qs()` helper's index signature) — this predates this file and does not block the real build (`vite build` uses esbuild, not `tsc`, and doesn't type-check at all). Ignore those three; don't ignore anything else.
3. Build the frontend for real before deploying: `cd frontend && npm run build`.
4. Rebuild the image(s): `podman-compose build backend frontend` (or whichever changed).
   **Use `--no-cache` if you're not sure the change will be picked up** — this environment has intermittently served a stale cached layer even after a source file changed, silently keeping old code in the new image. If in doubt, `podman-compose build --no-cache <service>` and confirm directly:
   ```bash
   podman run --rm localhost/open-cdr-platform_backend:latest ls dist/<path>
   ```
5. **Recreating containers from a freshly built image is not automatic.** `podman-compose up -d` will *not* swap a running container onto a same-tag rebuilt image by itself. Force it:
   ```bash
   podman rm -f opencdr-backend opencdr-frontend   # whichever changed
   podman-compose up -d
   ```
   If `podman rm -f` complains about "dependent containers" on the first one, remove the *other* container first, then retry — this is a `podman-compose` quirk with this stack's `depends_on` chain, not a real dependency problem.
6. **Verify against the real running stack, not just the build.** This project's whole verification discipline is: confirm the container is actually on the new image ID (`podman inspect <name> --format '{{.Image}}'` vs `podman images <tag> --format '{{.Id}}'`), then exercise the change with `curl` against real data (cross-check counts against direct `psql` queries where it matters) and, for frontend-only changes, confirm the new strings exist in the served bundle (`curl .../assets/index-*.js | grep '...'`). There is no browser automation tool in this environment — say so explicitly rather than claiming a UI change was "tested" when it was only type-checked and built.
7. `pwd` drifts between tool calls in this environment — `cd backend && npm run build` from a stale directory has silently run the *other* package's script more than once this session (frontend `npm run build` executing `tsc` because cwd was actually `backend/`). Always confirm `pwd` before an ambiguous `npm run` if the previous command changed directories.

## Codebase conventions

- **Migrations**: sequential, numbered, in `backend/src/migrations/` (`001_...` through `007_...` currently). Never edit a shipped migration — add a new one. `runMigrations()` applies whatever hasn't run yet, tracked in a schema-migrations table.
- **Layering**: `routes/` (Express handlers, zod-parse the request, call a service, `next(err)` on failure) → `services/` (business logic + SQL) → `db/pool.ts` (`query`/`queryOne` helpers). Don't put SQL in routes or route-shaped logic in services.
- **Auth**: `middleware/auth.ts` — `requireAuth` (session cookie or per-user API key, sets `req.user`), `requireAdmin` (role check), `requireApiKey` (ingest — `INGEST_API_KEY` or a per-user key), `requireAdminKey` (backup/restore — `ADMIN_API_KEY` or an admin session), `scopeFilters` (intersects a user's `allowedGroups`/`allowedSourcePlatformIds` with whatever the request asks for). New authenticated endpoints should compose these, not reinvent auth checks.
- **Audit logging is automatic, not opt-in**: `middleware/audit.ts` logs every request globally via `res.on("finish")`. You don't need to add logging calls to a new route — you'd only touch this if a route needs `res.locals.auditRecordCount` set for a richer log entry, or needs adding to the skip list (only do that for genuinely noise-only unauthenticated endpoints).
- **Zod is the gatekeeper**: `schemas/cdr.ts` mirrors the Open CDR Standard exactly (`.nullish()` not `.optional()` — the standard's own examples use explicit `null`). Ingest validates every record against this before it's stored, so the store only ever holds conforming data. If you add a field the standard doesn't define, it's a documented "platform extension," not a schema change.
- **No comments unless the *why* is non-obvious.** This codebase is intentionally comment-light — well-named identifiers carry the *what*. Existing comments in this repo explain hidden constraints or rationale for a non-default choice (e.g. why bcrypt vs. a fast hash, why a middleware runs before vs. after another). Match that bar, don't add narration.
- **Frontend has no component library or router.** New UI is a new function in `App.tsx` following the existing patterns: `Pill`/`Field`/`Section` atoms, the `ExportMenu`/`Pager` components are generic and reusable, overlays follow the `IngestModal`/`AuditLogModal` full-screen-centered pattern, small per-user panels follow the `UsersSection`/`ApiKeysSection` inline-list-in-a-dropdown pattern. Reuse before adding a new pattern.
- **The Roadmap lives in README.md's `## Roadmap` section**, not here and not in issues. "Not yet implemented" → "Done" (strikethrough + a one-line description of what actually shipped) only moves **when the user explicitly says so** — never flip a Roadmap item on your own inference that it's finished, even if you just built it. If you notice a Roadmap bullet is stale (already done, or a new gap you found), say so and let the user decide.
- **New backlog items get added to README's Roadmap "Not yet implemented" list as they come up in conversation** — this project tracks its backlog in the README, not elsewhere.

## Auth for local testing

There is no fixed admin password — see README's [Authentication & scoped access](./README.md#authentication--scoped-access). If you need a session for `curl` verification and don't have current credentials, don't guess or reset the real admin account; create a disposable admin user instead and delete it when done:

```bash
podman exec opencdr-backend node -e "require('bcryptjs').hash('temp-pass', 10).then(console.log)"
podman exec opencdr-db psql -U opencdr -d opencdr -c \
  "INSERT INTO users (username, password_hash, role) VALUES ('temp-verify', '<hash>', 'admin');"
# ...verify...
podman exec opencdr-db psql -U opencdr -d opencdr -c "DELETE FROM users WHERE username = 'temp-verify';"
```

## The standard itself lives in a sibling repo

`/home/chris/local-repos/open-cdr-project` is the canonical Open CDR Standard (`cdr-schema.yaml` and `cdr-examples.json` at its root) — a separate repo from this one. This platform's `backend/src/data/cdr-schema.yaml` and `cdr-examples.json` are **vendored copies**, not live references (`/openapi.json`/`/docs` serve the schema directly from disk; the examples file is what `seedExamples()`/`npm run seed` loads). The two repos can drift. If asked about "does the schema support X," check the vendored copies for what *this platform* currently validates/serves, but if the answer seems surprising or the user pushes back, diff against the sibling repo — `diff open-cdr-project/cdr-schema.yaml open-cdr-platform/backend/src/data/cdr-schema.yaml` (and the same for `cdr-examples.json`) — before concluding the standard itself doesn't have it. Syncing a change in is manual: update the vendored files, then mirror the same shape into `schemas/cdr.ts` (zod) by hand — nothing generates one from the other. After touching either vendored file, re-validate the examples against the compiled schema before calling it done:
```bash
cd backend && npm run build && node -e "
const { callRecordSchema } = require('./dist/schemas/cdr');
const data = require('./src/data/cdr-examples.json');
data.examples.forEach(e => callRecordSchema.parse(e));
console.log(data.examples.length + ' examples OK');
"
```

## One-off scripts

`backend/src/db/` has four standalone runners (`if (require.main === module)`), each also invocable via `npm run <script>`:

- `seed.ts` (`npm run seed`) — the standard's 5 example scenarios, runs automatically on boot if `call_records` is empty.
- `seedAdmin.ts` — bootstrap admin account, runs automatically on boot if `users` is empty. Not a standalone script.
- `seedDemo.ts` (`npm run seed:demo`) — 5,000 rich synthetic records over the last 6 months, exercising nearly every schema field. Manual/opt-in only, never runs automatically. Idempotent-safe to re-run (upserts by `callId`), but re-running without clearing old `demo5k-*` rows first just adds another 5,000 on top.
- `seedDemo12mo.ts` (`npm run seed:demo:12mo`) — same generator as `seedDemo.ts` (it calls `seedDemoData()` with different options, not a copy of the logic), spread over 12 months instead of 6 and tagged `demo12mo-*` instead of `demo5k-*` so the two batches stay independently identifiable/clearable. Still 5,000 records — wider spread, not more volume. If you need a third variant, add its window/prefix in a similarly thin new file rather than duplicating `seedDemo.ts`'s ~20 scenario functions; `TIME_WINDOW_MS`/`ID_PREFIX` are deliberately mutable module state in `seedDemo.ts` for exactly this.
