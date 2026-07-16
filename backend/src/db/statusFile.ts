import fs from "fs";

export interface LastAttempt {
  at: string;
  status: "ok" | "failed";
}

// Shared by backup.ts (.last-attempt, written by scripts/backup.sh) and
// pitr.ts (.pitr-last-attempt, written by postgres/docker-entrypoint-wrapper.sh)
// — same "<UTC timestamp> ok|failed" marker-file convention, one parser.
export function readLastAttempt(file: string): LastAttempt | null {
  if (!fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, "utf-8").trim();
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx === -1) return null;
  const at = line.slice(0, spaceIdx);
  const status = line.slice(spaceIdx + 1);
  if (status !== "ok" && status !== "failed") return null;
  return { at, status };
}
