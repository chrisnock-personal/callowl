import { describe, it, expect, afterEach, afterAll } from "vitest";
import { ingestRecords } from "./ingestService";
import { query, closePool } from "../db/pool";
import type { CallRecordInput } from "../schemas/cdr";

interface CallRecordRow {
  call_id: string;
  call_state: string;
  duration_seconds: string | null;
  groups: string[];
  order_time: string;
  record: CallRecordInput;
}

function baseRecord(overrides: Partial<CallRecordInput> = {}): CallRecordInput {
  return {
    callId: "ingest-test-1",
    callStartTime: "2026-01-01T00:00:00.000Z",
    callState: "ongoing",
    mediaType: "voice",
    participants: [
      { participantId: "p1", role: "caller", extension: "1001", group: "sales" },
      { participantId: "p2", role: "callee", extension: "1002" },
    ],
    ...overrides,
  } as CallRecordInput;
}

async function getRow(callId: string): Promise<CallRecordRow | undefined> {
  const rows = await query<CallRecordRow>(
    "SELECT * FROM call_records WHERE call_id = $1",
    [callId]
  );
  return rows[0];
}

afterEach(async () => {
  await query("TRUNCATE call_records");
});

afterAll(async () => {
  await closePool();
});

describe("ingestRecords — create", () => {
  it("creates a new row and reports action: created", async () => {
    const record = baseRecord();
    const [result] = await ingestRecords(record);

    expect(result).toEqual({ callId: record.callId, action: "created" });

    const row = await getRow(record.callId);
    expect(row).toBeDefined();
    expect(row!.call_state).toBe("ongoing");
    expect(row!.groups).toEqual(["sales"]);
    // record is stored verbatim
    expect(row!.record.callId).toBe(record.callId);
    expect(row!.record.participants).toHaveLength(2);
  });

  it("derives order_time as lastUpdateTime, then callEndTime, then callStartTime", async () => {
    const record = baseRecord({
      callStartTime: "2026-01-01T00:00:00.000Z",
      callEndTime: "2026-01-01T00:10:00.000Z",
      lastUpdateTime: "2026-01-01T00:12:00.000Z",
    });
    await ingestRecords(record);
    const row = await getRow(record.callId);
    expect(new Date(row!.order_time).toISOString()).toBe("2026-01-01T00:12:00.000Z");
  });
});

describe("ingestRecords — update (re-ingest same callId)", () => {
  it("updates the existing row in place rather than duplicating it", async () => {
    const record = baseRecord({ callState: "ongoing" });
    await ingestRecords(record);

    const updated = baseRecord({
      callState: "ended",
      callEndTime: "2026-01-01T00:15:00.000Z",
      durationSeconds: 900,
    });
    const [result] = await ingestRecords(updated);

    expect(result).toEqual({ callId: record.callId, action: "updated" });

    const allRows = await query<CallRecordRow>(
      "SELECT * FROM call_records WHERE call_id = $1",
      [record.callId]
    );
    expect(allRows).toHaveLength(1);
    expect(allRows[0].call_state).toBe("ended");
    expect(Number(allRows[0].duration_seconds)).toBe(900);
  });
});

describe("ingestRecords — batch", () => {
  it("ingests a batch in one transaction, results lining up with input order", async () => {
    const records = [
      baseRecord({ callId: "batch-1" }),
      baseRecord({ callId: "batch-2" }),
      baseRecord({ callId: "batch-3" }),
    ];
    const results = await ingestRecords(records);

    expect(results.map((r) => r.callId)).toEqual(["batch-1", "batch-2", "batch-3"]);
    expect(results.every((r) => r.action === "created")).toBe(true);

    const rows = await query<CallRecordRow>("SELECT call_id FROM call_records ORDER BY call_id");
    expect(rows.map((r) => r.call_id)).toEqual(["batch-1", "batch-2", "batch-3"]);
  });

  it("rolls back the whole batch if one record fails at the database level", async () => {
    const records = [
      baseRecord({ callId: "batch-ok" }),
      // call_start_time is NOT NULL at the DB level; an undefined value here
      // serializes to SQL NULL and should fail that constraint, taking the
      // whole transaction (including the already-inserted "batch-ok" row)
      // down with it via the service's own ROLLBACK.
      { ...baseRecord({ callId: "batch-bad" }), callStartTime: undefined as unknown as string },
    ];

    await expect(ingestRecords(records)).rejects.toThrow();

    const rows = await query<CallRecordRow>("SELECT call_id FROM call_records");
    expect(rows).toHaveLength(0);
  });
});
