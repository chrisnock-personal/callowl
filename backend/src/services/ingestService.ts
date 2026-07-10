import { PoolClient } from "pg";
import { getPool } from "../db/pool";
import type { CallRecordInput } from "../schemas/cdr";

export interface IngestResult {
  callId: string;
  action: "created" | "updated";
}

/**
 * Derive the queryable column projection from a spec-compliant CallRecord.
 * The record itself is stored verbatim; these are only indexing aids.
 */
function project(record: CallRecordInput) {
  const groups = Array.from(
    new Set(
      (record.participants ?? [])
        .map((p) => p.group)
        .filter((g): g is string => typeof g === "string" && g.length > 0)
    )
  );

  // order_time: lastUpdateTime, then callEndTime, then callStartTime (spec ordering).
  const orderTime =
    record.lastUpdateTime ?? record.callEndTime ?? record.callStartTime;

  return {
    callId: record.callId,
    parentCallId: record.parentCallId ?? null,
    tenantId: record.tenantId ?? null,
    sourcePlatformId: record.sourcePlatformId ?? null,
    interactionStartTime: record.interactionStartTime ?? null,
    callStartTime: record.callStartTime,
    callEndTime: record.callEndTime ?? null,
    interactionEndTime: record.interactionEndTime ?? null,
    lastUpdateTime: record.lastUpdateTime ?? null,
    durationSeconds: record.durationSeconds ?? null,
    orderTime,
    callState: record.callState,
    callDirection: record.callDirection ?? null,
    callType: record.callType ?? null,
    mediaType: record.mediaType,
    groups,
    recordingStatus: record.cloudRecording?.recordingStatus ?? null,
  };
}

const UPSERT_SQL = `
  INSERT INTO call_records (
    call_id, parent_call_id, tenant_id, source_platform_id,
    interaction_start_time, call_start_time, call_end_time,
    interaction_end_time, last_update_time, duration_seconds, order_time,
    call_state, call_direction, call_type, media_type,
    groups, recording_status, record
  ) VALUES (
    $1, $2, $3, $4,
    $5, $6, $7,
    $8, $9, $10, $11,
    $12, $13, $14, $15,
    $16, $17, $18
  )
  ON CONFLICT (call_id) DO UPDATE SET
    parent_call_id         = EXCLUDED.parent_call_id,
    tenant_id              = EXCLUDED.tenant_id,
    source_platform_id     = EXCLUDED.source_platform_id,
    interaction_start_time = EXCLUDED.interaction_start_time,
    call_start_time        = EXCLUDED.call_start_time,
    call_end_time          = EXCLUDED.call_end_time,
    interaction_end_time   = EXCLUDED.interaction_end_time,
    last_update_time       = EXCLUDED.last_update_time,
    duration_seconds       = EXCLUDED.duration_seconds,
    order_time             = EXCLUDED.order_time,
    call_state             = EXCLUDED.call_state,
    call_direction         = EXCLUDED.call_direction,
    call_type              = EXCLUDED.call_type,
    media_type             = EXCLUDED.media_type,
    groups                 = EXCLUDED.groups,
    recording_status       = EXCLUDED.recording_status,
    record                 = EXCLUDED.record,
    updated_at             = now()
  RETURNING (xmax = 0) AS inserted
`;

async function upsertOne(
  record: CallRecordInput,
  client?: PoolClient
): Promise<IngestResult> {
  const p = project(record);
  const params = [
    p.callId,
    p.parentCallId,
    p.tenantId,
    p.sourcePlatformId,
    p.interactionStartTime,
    p.callStartTime,
    p.callEndTime,
    p.interactionEndTime,
    p.lastUpdateTime,
    p.durationSeconds,
    p.orderTime,
    p.callState,
    p.callDirection,
    p.callType,
    p.mediaType,
    p.groups,
    p.recordingStatus,
    JSON.stringify(record),
  ];
  const runner = client ?? getPool();
  const result = await runner.query<{ inserted: boolean }>(UPSERT_SQL, params);
  return {
    callId: p.callId,
    action: result.rows[0]?.inserted ? "created" : "updated",
  };
}

/** Ingest one record or a batch. A batch runs in a single transaction. */
export async function ingestRecords(
  input: CallRecordInput | CallRecordInput[]
): Promise<IngestResult[]> {
  const records = Array.isArray(input) ? input : [input];
  if (records.length === 1) return [await upsertOne(records[0])];

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const results: IngestResult[] = [];
    for (const r of records) results.push(await upsertOne(r, client));
    await client.query("COMMIT");
    return results;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
