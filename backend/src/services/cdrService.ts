import { query, queryOne } from "../db/pool";
import type { CallRecord, CallRecordPage } from "../types";
import { parseAdvancedFilter } from "./advancedFilter";

export interface ListFilters {
  startTime: string; // required (inclusive)
  endTime: string; // required (exclusive)
  mediaType?: string[]; // OR across values
  groups?: string[]; // include (overlap)
  excludeGroups?: string[]; // exclude (overlap)
  tenantId?: string; // X-Tenant-Id
  sourcePlatformId?: string[]; // platform extension — OR across values
  participant?: string; // platform extension — matches participantId/userId/displayName/extension
  queue?: string[]; // platform extension — matches callSource.queueInfo, OR across values
  ivr?: string[]; // platform extension — matches callSource.ivrInfo, OR across values
  advanced?: string; // platform extension — "mos < 3, jitter > 50" style numeric conditions
  page: number;
  pageSize: number;
}

/**
 * GET /calls. Filters on the query window, media type, groups and tenant (the
 * standard's documented filters), plus sourcePlatformId, participant search,
 * queue, ivr, and advanced numeric conditions (platform extensions — not part
 * of the standard's documented API, same as /calls/ingest). Returns a page
 * ordered by order_time ascending (lastUpdateTime, falling back to endTime
 * then startTime), exactly as the standard documents.
 */
export async function listCallRecords(
  f: ListFilters
): Promise<CallRecordPage> {
  const where: string[] = ["order_time >= $1", "order_time < $2"];
  const params: unknown[] = [f.startTime, f.endTime];

  if (f.mediaType && f.mediaType.length) {
    params.push(f.mediaType);
    where.push(`media_type = ANY($${params.length})`);
  }
  // groups/sourcePlatformId: defined-but-empty is distinct from absent. It
  // only arises from access scoping (a scoped user's allowed set intersected
  // with an out-of-scope request lands on []), and has to mean "matches
  // nothing" — `groups && '{}'` is false for every row in Postgres, so
  // passing the empty array through (rather than skipping the filter like a
  // truthy+length check would) gets that "deny" for free.
  if (f.groups !== undefined) {
    params.push(f.groups);
    where.push(`groups && $${params.length}`);
  }
  if (f.excludeGroups && f.excludeGroups.length) {
    params.push(f.excludeGroups);
    where.push(`NOT (groups && $${params.length})`);
  }
  if (f.tenantId) {
    params.push(f.tenantId);
    where.push(`tenant_id = $${params.length}`);
  }
  if (f.sourcePlatformId !== undefined) {
    params.push(f.sourcePlatformId);
    where.push(`source_platform_id = ANY($${params.length})`);
  }
  if (f.participant) {
    params.push(`%${f.participant}%`);
    where.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements(record->'participants') AS p
       WHERE p->>'participantId' ILIKE $${params.length}
          OR p->>'userId'        ILIKE $${params.length}
          OR p->>'displayName'   ILIKE $${params.length}
          OR p->>'extension'     ILIKE $${params.length}
    )`);
  }
  if (f.queue && f.queue.length) {
    params.push(f.queue);
    where.push(`record->'callSource'->>'queueInfo' = ANY($${params.length})`);
  }
  if (f.ivr && f.ivr.length) {
    params.push(f.ivr);
    where.push(`record->'callSource'->>'ivrInfo' = ANY($${params.length})`);
  }
  if (f.advanced) {
    for (const clause of parseAdvancedFilter(f.advanced)) {
      params.push(clause.value);
      where.push(`${clause.column} ${clause.operator} $${params.length}`);
    }
  }

  const whereSql = where.join(" AND ");

  const countRow = await queryOne<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM call_records WHERE ${whereSql}`,
    params
  );
  const totalRecords = parseInt(countRow?.total ?? "0", 10);

  const limit = f.pageSize;
  const offset = (f.page - 1) * f.pageSize;
  params.push(limit, offset);

  const rows = await query<{ record: CallRecord }>(
    `SELECT record
       FROM call_records
      WHERE ${whereSql}
      ORDER BY order_time ASC, id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    data: rows.map((r) => r.record),
    pagination: {
      page: f.page,
      pageSize: f.pageSize,
      totalPages: Math.max(1, Math.ceil(totalRecords / f.pageSize)),
      totalRecords,
    },
  };
}

/**
 * GET /calls/{callId}. Tenant-scoped when a tenant header is supplied, and
 * access-scoped when the caller has restricted groups/sourcePlatformIds — a
 * scoped user asking for a record outside their access gets the same 404 as
 * a record that doesn't exist, rather than a 403 that would confirm it does.
 */
export async function getCallRecord(
  callId: string,
  tenantId?: string,
  scope?: { groups?: string[]; sourcePlatformId?: string[] }
): Promise<CallRecord | null> {
  const where: string[] = ["call_id = $1"];
  const params: unknown[] = [callId];
  if (tenantId) {
    params.push(tenantId);
    where.push(`tenant_id = $${params.length}`);
  }
  if (scope?.groups !== undefined) {
    params.push(scope.groups);
    where.push(`groups && $${params.length}`);
  }
  if (scope?.sourcePlatformId !== undefined) {
    params.push(scope.sourcePlatformId);
    where.push(`source_platform_id = ANY($${params.length})`);
  }
  const sql = `SELECT record FROM call_records WHERE ${where.join(" AND ")}`;
  const row = await queryOne<{ record: CallRecord }>(sql, params);
  return row?.record ?? null;
}
