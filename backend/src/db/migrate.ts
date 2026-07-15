import fs from "fs";
import path from "path";
import { getPool } from "./pool";
import { logger } from "../logger";

const MIGRATIONS_DIR = path.join(__dirname, "../migrations");

async function ensureMigrationsTable(
  client: import("pg").PoolClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(
  client: import("pg").PoolClient
): Promise<Set<string>> {
  const result = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  return new Set(result.rows.map((r) => r.version));
}

function getMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export async function runMigrations(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const files = getMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      logger.info("Database schema up to date");
      await client.query("COMMIT");
      return;
    }

    logger.info("Applying migrations", { count: pending.length, files: pending });
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      logger.info("Applying migration", { file });
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [file]
      );
    }
    await client.query("COMMIT");
    logger.info("Migrations complete");
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("Migration failed", { err });
    throw err;
  } finally {
    client.release();
  }
}

// Standalone runner (npm run migrate)
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("Migration runner failed", { err });
      process.exit(1);
    });
}
