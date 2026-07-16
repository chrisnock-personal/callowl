import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { config } from "../config";
import { readLastAttempt, LastAttempt } from "./statusFile";

// Same naming convention as scripts/backup.sh, so on-demand and scheduled
// dumps land in the same directory and list together.
function filenameFor(date: Date): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `opencdr-${stamp}.dump`;
}

export interface BackupResult {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

function requireBackupsDir(): string {
  const dir = config.backups.dir;
  if (!dir) {
    throw new Error(
      "BACKUPS_DIR is not configured — the backups volume isn't mounted on this container"
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pgEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGPASSWORD: config.db.password,
  };
}

/** Runs pg_dump (custom format) to a new timestamped file in the backups dir. */
export async function runBackupNow(): Promise<BackupResult> {
  const dir = requireBackupsDir();
  const now = new Date();
  const filename = filenameFor(now);
  const outPath = path.join(dir, filename);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "pg_dump",
      [
        "--host", config.db.host,
        "--port", String(config.db.port),
        "--username", config.db.user,
        "--dbname", config.db.database,
        "--format", "custom",
        "--compress", "6",
        "--file", outPath,
      ],
      { env: pgEnv() }
    );
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited ${code}: ${stderr.trim()}`));
    });
  });

  const stat = fs.statSync(outPath);
  return { filename, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
}

// pg_dump's custom format always starts with this 5-byte signature — a cheap
// sanity check before we hand an upload to pg_restore --clean, which starts
// dropping objects as soon as it runs.
const CUSTOM_FORMAT_MAGIC = Buffer.from("PGDMP");

export function looksLikePgDumpCustomFormat(buf: Buffer): boolean {
  return buf.subarray(0, 5).equals(CUSTOM_FORMAT_MAGIC);
}

/** Restores a pg_dump (custom format) buffer, replacing conflicting objects. */
export async function restoreFromBuffer(buf: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "pg_restore",
      [
        "--host", config.db.host,
        "--port", String(config.db.port),
        "--username", config.db.user,
        "--dbname", config.db.database,
        "--clean",
        "--if-exists",
        "--no-owner",
      ],
      { env: pgEnv() }
    );
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_restore exited ${code}: ${stderr.trim()}`));
    });
    proc.stdin.end(buf);
  });
}

export function listBackups(): BackupResult[] {
  const dir = config.backups.dir;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".dump"))
    .map((filename) => {
      const stat = fs.statSync(path.join(dir, filename));
      return { filename, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Guards against path traversal — only a filename matching our own naming scheme is valid. */
export function isValidBackupFilename(filename: string): boolean {
  return /^opencdr-\d{8}T\d{6}Z\.dump$/.test(filename);
}

export type { LastAttempt };

// Written by scripts/backup.sh on every scheduled run, success or failure —
// the only way a broken backup loop (disk full, DB unreachable, permissions)
// becomes visible anywhere other than `podman logs`. On-demand backups
// triggered from the dashboard/API don't touch this file; it reflects the
// scheduled `backup` service specifically.
export function getLastAttempt(): LastAttempt | null {
  const dir = config.backups.dir;
  if (!dir) return null;
  return readLastAttempt(path.join(dir, ".last-attempt"));
}
