import { query, queryOne } from "../db/pool";
import { config } from "../config";

export async function isStatusPageEnabled(): Promise<boolean> {
  const row = await queryOne<{ enabled: boolean }>(
    "SELECT enabled FROM status_page_config WHERE id = 1"
  );
  return row?.enabled ?? false;
}

export async function setStatusPageEnabled(enabled: boolean): Promise<void> {
  await query(
    "UPDATE status_page_config SET enabled = $1, updated_at = now() WHERE id = 1",
    [enabled]
  );
}

export interface PublicStatusComponent {
  name: string;
  status: "operational" | "unavailable";
}

export interface PublicStatus {
  status: "operational" | "unavailable";
  timestamp: string;
  apiVersion: string;
  components: PublicStatusComponent[];
}

// Deliberately minimal — this is served with no auth at all, so it only ever
// reports coarse up/down, the same two states GET /health already exposes
// publicly. It does not reuse services/alertService.ts's conditions (backup/
// PITR/off-host-sync staleness, remote-source poll errors and their names):
// those are real operational detail meant for the people running this
// platform, not something to hand to an anonymous visitor.
export async function getPublicStatus(): Promise<PublicStatus> {
  let dbOk = true;
  try {
    await query("SELECT 1");
  } catch {
    dbOk = false;
  }

  const components: PublicStatusComponent[] = [
    { name: "API", status: "operational" },
    { name: "Database", status: dbOk ? "operational" : "unavailable" },
  ];

  return {
    status: dbOk ? "operational" : "unavailable",
    timestamp: new Date().toISOString(),
    apiVersion: config.apiVersion,
    components,
  };
}
