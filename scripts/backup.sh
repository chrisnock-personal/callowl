#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Dumps the opencdr database to /backups (custom pg_dump format, compressed),
# then prunes dumps older than BACKUP_RETENTION_DAYS. Runs inside the `backup`
# compose service (a plain postgres:16-alpine image, which already ships
# pg_dump) on a loop — see docker-compose.yml. Can also be run manually. Note
# the `backup` service has a fixed entrypoint (the loop itself), so a one-off
# run needs --entrypoint to actually invoke this script instead:
#
#   podman-compose run --rm --entrypoint sh backup /scripts/backup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/opencdr-${STAMP}.dump"

mkdir -p "$BACKUP_DIR"

echo "[backup] $(date -u +%FT%TZ) dumping ${PGDATABASE} -> ${OUT}"
PGPASSWORD="$PGPASSWORD" pg_dump \
  --host="$PGHOST" --port="${PGPORT:-5432}" \
  --username="$PGUSER" --dbname="$PGDATABASE" \
  --format=custom --compress=6 \
  --file="$OUT"

echo "[backup] done ($(du -h "$OUT" | cut -f1))"

echo "[backup] pruning dumps older than ${RETENTION_DAYS}d in ${BACKUP_DIR}"
find "$BACKUP_DIR" -name 'opencdr-*.dump' -mtime "+${RETENTION_DAYS}" -print -delete
