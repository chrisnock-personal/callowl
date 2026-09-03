#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Mirrors both backup artifacts — pg_dump dumps in /backups and the
# pgBackRest/PITR repo in the internal `minio` service's bucket — to a
# separate S3-compatible target (OFFSITE_S3_*), closing the "full host loss"
# gap DISASTER_RECOVERY.md's Scenario B calls out: neither artifact survives
# losing this host on its own, since both live on it. No-ops if
# OFFSITE_S3_ENDPOINT/OFFSITE_S3_BUCKET aren't set, so the offsite-backup
# compose service can stay present (and its status visible in the dashboard's
# Backups panel) without forcing every deployment to configure an off-host
# target. Runs inside that service on the same run/sleep/repeat loop as
# scripts/backup.sh — see docker-compose.yml.
#
#   podman-compose run --rm --entrypoint sh offsite-backup /scripts/offsite-sync.sh
# ─────────────────────────────────────────────────────────────────────────────
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
STATUS_FILE="${BACKUP_DIR}/.offsite-last-attempt"

# Same convention as scripts/backup.sh's own .last-attempt — read by the
# backend's GET /admin/backups so a broken sync (bad creds, unreachable
# endpoint, full remote bucket) is visible in the dashboard instead of only
# ever reaching `podman logs`.
write_status() {
  echo "$(date -u +%FT%TZ) $1" > "$STATUS_FILE"
}

if [ -z "${OFFSITE_S3_ENDPOINT:-}" ] || [ -z "${OFFSITE_S3_BUCKET:-}" ]; then
  echo "[offsite-backup] OFFSITE_S3_ENDPOINT/OFFSITE_S3_BUCKET not set — skipping (see README's Backup & maintenance)"
  exit 0
fi

trap 'write_status failed' EXIT

OFFSITE_INSECURE_FLAG=""
[ "${OFFSITE_S3_INSECURE:-false}" = "true" ] && OFFSITE_INSECURE_FLAG="--insecure"

mc alias set offsite "$OFFSITE_S3_ENDPOINT" "$OFFSITE_S3_ACCESS_KEY" "$OFFSITE_S3_SECRET_KEY" $OFFSITE_INSECURE_FLAG >/dev/null
# `minio` speaks TLS with a self-signed cert (see minio/Dockerfile) — always
# insecure here regardless of OFFSITE_S3_INSECURE, which only concerns the
# offsite alias above.
mc alias set local "https://minio:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --insecure >/dev/null

echo "[offsite-backup] $(date -u +%FT%TZ) mirroring pg_dump backups -> offsite/${OFFSITE_S3_BUCKET}/pg_dumps"
# --remove keeps the offsite copy matching local retention (BACKUP_RETENTION_DAYS)
# rather than accumulating independently forever — drop it if you'd rather the
# offsite copy outlive local pruning. --exclude skips the status marker files
# living alongside the dumps in the same directory.
mc mirror --overwrite --remove --exclude ".*" $OFFSITE_INSECURE_FLAG "$BACKUP_DIR" "offsite/${OFFSITE_S3_BUCKET}/pg_dumps"

echo "[offsite-backup] mirroring PITR repo (MinIO bucket ${MINIO_BUCKET}) -> offsite/${OFFSITE_S3_BUCKET}/pitr"
mc mirror --overwrite --remove --insecure $OFFSITE_INSECURE_FLAG "local/${MINIO_BUCKET}" "offsite/${OFFSITE_S3_BUCKET}/pitr"

echo "[offsite-backup] done"
write_status ok
trap - EXIT
