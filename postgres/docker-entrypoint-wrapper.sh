#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Backgrounds pgBackRest stanza setup + periodic base backups, then execs into
# the STOCK, unmodified postgres:16-alpine entrypoint (still present at this
# path in the base image) for the actual server startup. Deliberately kept
# this simple and decoupled: a bug in the pgbackrest loop below can't prevent
# Postgres itself from starting normally, since it's a background job that
# the real entrypoint knows nothing about, not a combined/patched script.
#
# archive_command (set via docker-compose.yml's command: override) starts
# firing as soon as Postgres begins archiving WAL segments — before
# stanza-create has necessarily finished, if this container has never booted
# before. That's fine: a failed archive-push just makes Postgres retry it
# later (Postgres's own behavior, not something this script manages), so the
# only consequence of a slow/failed stanza-create is a delayed first archive,
# never a lost one.
#
# Runs as postgres (via su-exec, same tool the base image's own entrypoint
# uses to drop root) rather than as this wrapper's root — archive_command
# above is invoked directly by the Postgres server process, which already
# runs as postgres by the time it execs anything, so pgbackrest's spool/lock
# directory (/tmp/pgbackrest) needs one consistent owner across both access
# paths. Learned this the hard way: as root, stanza-create/backup created
# /tmp/pgbackrest owned by root, and archive-push then failed with
# "opencdr.stop: Permission denied" trying to read it as postgres.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

(
  until pg_isready -h localhost -U "$POSTGRES_USER" -q; do
    sleep 2
  done

  until su-exec postgres pgbackrest --stanza=opencdr stanza-create; do
    echo "[pgbackrest-init] stanza-create failed, retrying in 5s..."
    sleep 5
  done
  echo "[pgbackrest-init] stanza ready"

  # /backups is the same host ./backups directory scripts/backup.sh and the
  # backend already use — .pitr-last-attempt lets GET /admin/backups surface
  # base-backup health the same way .last-attempt already does for pg_dump.
  mkdir -p /backups
  while true; do
    if su-exec postgres pgbackrest --stanza=opencdr backup; then
      echo "[pgbackrest-backup] backup complete"
      echo "$(date -u +%FT%TZ) ok" > /backups/.pitr-last-attempt
    else
      echo "[pgbackrest-backup] backup failed, will retry next interval"
      echo "$(date -u +%FT%TZ) failed" > /backups/.pitr-last-attempt
    fi
    sleep "$(( ${PITR_BACKUP_INTERVAL_HOURS:-24} * 3600 ))"
  done
) &

exec docker-entrypoint.sh "$@"
