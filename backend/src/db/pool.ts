import { Pool, PoolClient } from "pg";
import { config } from "../config";

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(config.db);

    pool.on("error", (err) => {
      console.error("Unexpected PostgreSQL pool error:", err);
    });

    pool.on("connect", () => {
      if (config.nodeEnv === "development") {
        console.log("📦  New PostgreSQL client connected");
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

export async function testConnection(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT 1");
    console.log(
      `✅  PostgreSQL connected — ${config.db.host}:${config.db.port}/${config.db.database}`
    );
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
}
