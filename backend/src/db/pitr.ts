import path from "path";
import { config } from "../config";
import { logger } from "../logger";
import { queryOne } from "./pool";
import { readLastAttempt, LastAttempt } from "./statusFile";

export interface ArchiverStatus {
  archivedCount: number;
  lastArchivedWal: string | null;
  lastArchivedAt: string | null;
  failedCount: number;
  lastFailedWal: string | null;
  lastFailedAt: string | null;
}

interface ArchiverRow {
  archived_count: string;
  last_archived_wal: string | null;
  last_archived_time: Date | null;
  failed_count: string;
  last_failed_wal: string | null;
  last_failed_time: Date | null;
}

// pg_stat_archiver is Postgres's own built-in view of archive_command's
// history — no pgBackRest-specific plumbing needed for WAL-archiving health,
// unlike the base-backup status below. failed_count/last_failed_* are
// cumulative since stats_reset, not current state (a failed archive-push
// during every stanza-create retry-on-boot is expected and self-heals), so
// callers should drive any "is PITR broken" signal off lastArchivedAt's
// staleness, not off failedCount > 0.
export async function getArchiverStatus(): Promise<ArchiverStatus | null> {
  try {
    const row = await queryOne<ArchiverRow>(
      "SELECT archived_count, last_archived_wal, last_archived_time, failed_count, last_failed_wal, last_failed_time FROM pg_stat_archiver"
    );
    if (!row) return null;
    return {
      archivedCount: Number(row.archived_count),
      lastArchivedWal: row.last_archived_wal,
      lastArchivedAt: row.last_archived_time?.toISOString() ?? null,
      failedCount: Number(row.failed_count),
      lastFailedWal: row.last_failed_wal,
      lastFailedAt: row.last_failed_time?.toISOString() ?? null,
    };
  } catch (err) {
    logger.error("Failed to read pg_stat_archiver", { err });
    return null;
  }
}

// Written by postgres/docker-entrypoint-wrapper.sh's backup loop, same
// "<UTC timestamp> ok|failed" convention as scripts/backup.sh's
// .last-attempt — pg_stat_archiver only covers archive_command (continuous
// WAL shipping), not pgBackRest's own periodic full/incremental `backup`
// command, so that half needs its own marker file.
export function getBaseBackupLastAttempt(): LastAttempt | null {
  const dir = config.backups.dir;
  if (!dir) return null;
  return readLastAttempt(path.join(dir, ".pitr-last-attempt"));
}
