import { runMigrations } from "../db/migrate";
import { closePool } from "../db/pool";

// Requires PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD already set in the
// environment, pointed at a test database — same precondition `npm run dev`
// has for a real one. Runs once for the whole suite; reuses the exact
// migration runner production boot uses, so applying it twice in a row
// (e.g. two local `npm test` runs against the same test DB) must be a no-op,
// same as it is on a real server restart.
export async function setup() {
  await runMigrations();
}

export async function teardown() {
  await closePool();
}
