# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
ENV NODE_ENV=production
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

# Production deps only
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Compiled JS
COPY --from=build /app/dist ./dist
# tsc does not copy non-TS assets, and config/migrate resolve these relative to
# __dirname (…/dist/**), so place them under dist to match both dev and runtime.
COPY src/migrations ./dist/migrations
COPY src/data ./dist/data

EXPOSE 3001
CMD ["node", "dist/index.js"]
