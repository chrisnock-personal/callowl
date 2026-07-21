#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Restores a pg_dump (custom format) produced by backup.sh into the callowl
# database, replacing existing objects. Run from the repo root. The `backup`
# service has a fixed entrypoint (a backup loop), so --entrypoint is required
# to run this script instead of letting that loop start:
#
#   podman-compose run --rm --entrypoint sh backup /scripts/restore.sh /backups/callowl-<stamp>.dump
#
# --clean --if-exists drops conflicting objects first, so this is safe to run
# against a database that already has the table (e.g. re-provisioning a node).
# ─────────────────────────────────────────────────────────────────────────────
set -eu

FILE="${1:?usage: restore.sh <path-to-dump>}"

if [ ! -f "$FILE" ]; then
  echo "[restore] no such file: $FILE" >&2
  exit 1
fi

echo "[restore] $(date -u +%FT%TZ) restoring ${FILE} -> ${PGDATABASE}"
PGPASSWORD="$PGPASSWORD" pg_restore \
  --host="$PGHOST" --port="${PGPORT:-5432}" \
  --username="$PGUSER" --dbname="$PGDATABASE" \
  --clean --if-exists --no-owner \
  "$FILE"

echo "[restore] done"
