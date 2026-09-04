import { describe, it, expect, afterEach, afterAll } from "vitest";
import { checkAndNotify } from "./alertService";
import { query, closePool } from "../db/pool";

afterEach(async () => {
  await query("TRUNCATE remote_sources, alert_state CASCADE");
});

afterAll(async () => {
  await closePool();
});

async function insertRemoteSource(status: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `INSERT INTO remote_sources (name, base_url, auth_type, auth_config, backfill_from, last_poll_status, last_poll_error)
     VALUES ($1, 'https://example.com', 'api_key', '{}'::jsonb, now(), $2, 'boom')
     RETURNING id::text`,
    ["alert-test-source", status]
  );
  return parseInt(rows[0].id, 10);
}

describe("checkAndNotify — batched read/upsert still gets the decision right", () => {
  it("records an unhealthy condition on first observation", async () => {
    const id = await insertRemoteSource("fetch_error");

    await checkAndNotify();

    const rows = await query<{ healthy: boolean; last_alert_at: string | null }>(
      "SELECT healthy, last_alert_at FROM alert_state WHERE condition = $1",
      [`remote_source_poll:${id}`]
    );
    expect(rows[0]?.healthy).toBe(false);
    expect(rows[0]?.last_alert_at).not.toBeNull();
  });

  it("does not bump last_alert_at again while still unhealthy within the cooldown", async () => {
    const id = await insertRemoteSource("fetch_error");

    await checkAndNotify();
    const first = await query<{ last_alert_at: Date }>(
      "SELECT last_alert_at FROM alert_state WHERE condition = $1",
      [`remote_source_poll:${id}`]
    );

    await checkAndNotify();
    const second = await query<{ last_alert_at: Date }>(
      "SELECT last_alert_at FROM alert_state WHERE condition = $1",
      [`remote_source_poll:${id}`]
    );

    // pg auto-parses TIMESTAMPTZ into Date objects — same instant, different
    // object identity, so compare the actual time, not object equality.
    expect(second[0].last_alert_at.getTime()).toBe(first[0].last_alert_at.getTime());
  });

  it("flips to healthy/recovered once the underlying condition clears", async () => {
    const id = await insertRemoteSource("fetch_error");
    await checkAndNotify();

    await query("UPDATE remote_sources SET last_poll_status = 'ok' WHERE id = $1", [id]);
    await checkAndNotify();

    const rows = await query<{ healthy: boolean }>(
      "SELECT healthy FROM alert_state WHERE condition = $1",
      [`remote_source_poll:${id}`]
    );
    expect(rows[0]?.healthy).toBe(true);
  });
});
