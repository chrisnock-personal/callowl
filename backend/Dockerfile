# npm has no Happy-Eyeballs-style fast IPv4 fallback the way curl does — a
# registry.npmjs.org DNS answer that includes a AAAA record npm happens to
# pick, in an environment where IPv6 egress is silently dropped rather than
# actively refused, means npm hangs on that connection for minutes instead of
# failing fast, even though curl against the exact same host succeeds
# immediately (confirmed the hard way: repeated `npm install` stalls with
# ~15s of real CPU time spread across 5+ minutes of wall time, while `curl`
# and a single `node -e https.get(...)` against the same registry URL both
# returned instantly). ipv4first doesn't disable IPv6, just deprioritizes it
# when both are available — harmless if this environment's IPv6 is actually
# fine. Set per-stage (ENV can't precede a Dockerfile's first FROM) — both
# stages here run npm install.

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS build
ENV NODE_OPTIONS=--dns-result-order=ipv4first
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--dns-result-order=ipv4first
WORKDIR /app

# pg_dump/pg_restore for the on-demand backup/restore endpoints (the scheduled
# `backup` compose service does the same via its own postgres:16-alpine image;
# this is for triggering one from the API/UI). Debian bookworm's own repo only
# has postgresql-client-15, and pg_dump refuses to dump a *newer* server than
# itself — so pull the versioned PGDG package matching the db image (16).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && apt-get purge -y --auto-remove curl gnupg \
  && rm -rf /var/lib/apt/lists/*

# python3 for executing admin-authored "custom" remote-source scripts
# (services/remoteScriptRunner.ts). python3-paramiko (SSH/SFTP) is here too —
# the flagship "custom source" use case is exactly a CUCM-style SFTP file
# scan (see the bundled example scripts in the dashboard's Remote sources
# panel), so it needs to actually work out of the box rather than being a
# script that immediately fails with ModuleNotFoundError. Both are plain
# Debian bookworm packages, no extra repo needed unlike postgresql-client-16
# above — kept as their own layer since they're unrelated to that block's
# PGDG add/purge dance.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-paramiko \
  && rm -rf /var/lib/apt/lists/*

# Production deps only
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Compiled JS
COPY --from=build /app/dist ./dist
# tsc does not copy non-TS assets, and config/migrate resolve these relative to
# __dirname (…/dist/**), so place them under dist to match both dev and runtime.
COPY src/migrations ./dist/migrations
COPY src/data ./dist/data

# Runs as root only long enough for docker-entrypoint.sh to fix up the
# ./backups bind mount's ownership, then drops to the image's built-in
# non-root `node` user before actually running the app — see that script for
# why this can't just be a build-time `USER node` + `chown`.
RUN mkdir -p /app/backups && chown -R node:node /app
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3001
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
