import { Pool, PoolClient } from "pg";
import { config } from "../config";
import { logger } from "../logger";

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(config.db);

    pool.on("error", (err) => {
      logger.error("Unexpected PostgreSQL pool error", { err });
    });

    pool.on("connect", () => {
      if (config.nodeEnv === "development") {
        logger.info("New PostgreSQL client connected");
      }
    });
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Builds a parameterized `SET col = $n, ...` clause plus its params array
 * from a { column: value } map, skipping any entry whose value is
 * `undefined` (an omitted patch field, not a real "set to null") — the
 * shared shape behind authService.ts's updateUser, remoteSourceService.ts's
 * updateRemoteSource and recordPollResult, which each used to hand-roll this
 * same push-to-sets/push-to-params dance separately. Doesn't add
 * `updated_at = now()` or the trailing `WHERE` param (an id) — those aren't
 * part of every caller's shape (recordPollResult also always-sets
 * `last_polled_at = now()`), so callers still append what they need after.
 * Returns `{ sets: [] }` (no params) when every value is undefined, same as
 * each caller's own pre-existing "nothing to update" short-circuit expects.
 */
export function buildSetClause(fields: Record<string, unknown>): {
  sets: string[];
  params: unknown[];
} {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  return { sets, params };
}

export async function testConnection(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT 1");
    logger.info("PostgreSQL connected", {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
    });
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
}
