import { query, queryOne } from "../db/pool";

export type ActorType = "user" | "ingest_key" | "admin_key" | "anonymous";

export interface AuditLogEvent {
  actorType: ActorType;
  actorId: string | null;
  method: string;
  path: string;
  statusCode: number;
  recordCount: number | null;
  params: Record<string, unknown> | null;
  ipAddress: string | null;
}

export interface AuditLogEntry extends AuditLogEvent {
  id: number;
  occurredAt: string;
}

interface AuditLogRow {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  method: string;
  path: string;
  status_code: number;
  record_count: number | null;
  params: Record<string, unknown> | null;
  ip_address: string | null;
}

function toEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: parseInt(row.id, 10),
    occurredAt: row.occurred_at,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id,
    method: row.method,
    path: row.path,
    statusCode: row.status_code,
    recordCount: row.record_count,
    params: row.params,
    ipAddress: row.ip_address,
  };
}

/**
 * Writes one audit row. Called fire-and-forget from middleware/audit.ts — a
 * logging failure must never break the request it's logging, so callers
 * should `.catch(() => {})` this rather than await it inline.
 */
export async function logEvent(e: AuditLogEvent): Promise<void> {
  await query(
    `INSERT INTO audit_log (actor_type, actor_id, method, path, status_code, record_count, params, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.actorType,
      e.actorId,
      e.method,
      e.path,
      e.statusCode,
      e.recordCount,
      e.params ? JSON.stringify(e.params) : null,
      e.ipAddress,
    ]
  );
}

export interface AuditLogFilters {
  actorId?: string;
  method?: string;
  pathPrefix?: string;
  startTime?: string;
  endTime?: string;
  page: number;
  pageSize: number;
}

export interface AuditLogPage {
  data: AuditLogEntry[];
  pagination: {
    page: number;
    pageSize: number;
    totalPages: number;
    totalRecords: number;
  };
}

/** GET /admin/audit-log. Newest first, filterable by actor/method/path/window. */
export async function listAuditLog(f: AuditLogFilters): Promise<AuditLogPage> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (f.actorId) {
    params.push(`%${f.actorId}%`);
    where.push(`actor_id ILIKE $${params.length}`);
  }
  if (f.method) {
    params.push(f.method.toUpperCase());
    where.push(`method = $${params.length}`);
  }
  if (f.pathPrefix) {
    params.push(`${f.pathPrefix}%`);
    where.push(`path LIKE $${params.length}`);
  }
  if (f.startTime) {
    params.push(f.startTime);
    where.push(`occurred_at >= $${params.length}`);
  }
  if (f.endTime) {
    params.push(f.endTime);
    where.push(`occurred_at < $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRow = await queryOne<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM audit_log ${whereSql}`,
    params
  );
  const totalRecords = parseInt(countRow?.total ?? "0", 10);

  const limit = f.pageSize;
  const offset = (f.page - 1) * f.pageSize;
  params.push(limit, offset);

  const rows = await query<AuditLogRow>(
    `SELECT id::text, occurred_at, actor_type, actor_id, method, path, status_code, record_count, params, ip_address
       FROM audit_log
       ${whereSql}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    data: rows.map(toEntry),
    pagination: {
      page: f.page,
      pageSize: f.pageSize,
      totalPages: Math.max(1, Math.ceil(totalRecords / f.pageSize)),
      totalRecords,
    },
  };
}

/** Deletes entries older than retentionDays. Run on boot and daily thereafter. */
export async function pruneAuditLog(retentionDays: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM audit_log WHERE occurred_at < now() - ($1 || ' days')::interval RETURNING id`,
    [retentionDays]
  );
  return rows.length;
}
