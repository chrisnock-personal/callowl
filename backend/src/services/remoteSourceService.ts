import { query, queryOne, buildSetClause } from "../db/pool";
import {
  encryptSecret,
  decryptSecretWithFallback,
  remoteSourceEncryptionKey,
  remoteSourceEncryptionKeyPrevious,
} from "./cryptoService";

export type RemoteSourceAuthType = "api_key" | "oauth2_client_credentials" | "custom";
// "skipped_locked" only ever appears in a transient PollSummary (another
// replica already held the poll lease for this source — see
// remotePollService.ts's tryClaimJob usage) — it's never persisted as
// lastPollStatus, since the replica that gets skipped never calls
// recordPollResult.
export type RemotePollStatus =
  | "ok"
  | "auth_error"
  | "fetch_error"
  | "validation_rejects"
  | "skipped_locked";

export interface RemoteSourceMeta {
  id: number;
  name: string;
  baseUrl: string;
  authType: RemoteSourceAuthType;
  enabled: boolean;
  pollIntervalMinutes: number;
  backfillFrom: string;
  watermark: string | null;
  lastPolledAt: string | null;
  lastPollStatus: RemotePollStatus | null;
  lastPollError: string | null;
  rejectCount: number;
  createdAt: string;
  updatedAt: string;
}

interface RemoteSourceRow {
  id: string;
  name: string;
  base_url: string;
  auth_type: string;
  auth_config: Record<string, unknown>; // pg auto-parses JSONB
  enabled: boolean;
  poll_interval_minutes: number;
  backfill_from: string;
  watermark: string | null;
  last_polled_at: string | null;
  last_poll_status: string | null;
  last_poll_error: string | null;
  reject_count: number;
  created_at: string;
  updated_at: string;
}

const REMOTE_SOURCE_COLUMNS = `
  rs.id::text, rs.name, rs.base_url, rs.auth_type, rs.auth_config, rs.enabled,
  rs.poll_interval_minutes, rs.backfill_from, rs.watermark, rs.last_polled_at,
  rs.last_poll_status, rs.last_poll_error, rs.created_at, rs.updated_at,
  (SELECT COUNT(*)::int FROM remote_source_rejects r WHERE r.remote_source_id = rs.id) AS reject_count
`;

// Same shape, minus the reject_count subquery — RemoteSourceInternal (what
// getRemoteSourceForPolling below returns) is consumed only by
// remotePollService.ts, which never reads rejectCount, so every poll tick
// for every due source was otherwise paying for a COUNT(*) scan over
// remote_source_rejects for nothing. 0 AS reject_count matches the same
// "not meaningful here" convention createRemoteSource's own RETURNING
// clause already uses right after insert, before any rejects could exist.
const REMOTE_SOURCE_COLUMNS_FOR_POLLING = `
  rs.id::text, rs.name, rs.base_url, rs.auth_type, rs.auth_config, rs.enabled,
  rs.poll_interval_minutes, rs.backfill_from, rs.watermark, rs.last_polled_at,
  rs.last_poll_status, rs.last_poll_error, rs.created_at, rs.updated_at,
  0 AS reject_count
`;

// pg auto-parses TIMESTAMPTZ columns into JS Date objects, not strings —
// harmless everywhere else in this codebase since every timestamp field only
// ever flows out through res.json(), and JSON.stringify() converts a Date to
// an ISO string automatically. remotePollService.ts is the first in-process
// (non-JSON-round-tripped) consumer of these fields — it puts watermark/
// backfillFrom straight into a URLSearchParams as the remote's startTime, so
// without this it silently sends Date.toString() output ("Tue Jul 14 2026
// 07:05:11 GMT+0000...") instead of ISO-8601, which a real remote would reject.
function toIso(v: unknown): string;
function toIso(v: unknown | null): string | null;
function toIso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toMeta(row: RemoteSourceRow): RemoteSourceMeta {
  return {
    id: parseInt(row.id, 10),
    name: row.name,
    baseUrl: row.base_url,
    authType: row.auth_type as RemoteSourceAuthType,
    enabled: row.enabled,
    pollIntervalMinutes: row.poll_interval_minutes,
    backfillFrom: toIso(row.backfill_from),
    watermark: toIso(row.watermark),
    lastPolledAt: toIso(row.last_polled_at),
    lastPollStatus: row.last_poll_status as RemotePollStatus | null,
    lastPollError: row.last_poll_error,
    rejectCount: row.reject_count,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// ─── Auth config shape ──────────────────────────────────────────────────────
// Secret fields inside auth_config are sealed via cryptoService.ts; clientId/
// tokenUrl/headerName stay plaintext since they aren't sensitive on their own.
// 'custom' seals its entire env map as one blob rather than splitting secret/
// non-secret entries — simpler, and errs safe by default (see remoteScriptRunner.ts
// for how scriptBody/env get executed).

export type RemoteSourceAuthInput =
  | { authType: "api_key"; apiKey: string; headerName?: string }
  | {
      authType: "oauth2_client_credentials";
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
    }
  | { authType: "custom"; scriptBody: string; env: Record<string, string> };

export type RemoteSourceAuth =
  | { authType: "api_key"; apiKey: string; headerName: string }
  | {
      authType: "oauth2_client_credentials";
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
    }
  | { authType: "custom"; scriptBody: string; env: Record<string, string> };

// Exported for backend/src/db/rotateEncryptionKeys.ts — a decrypt (with
// rotation-window fallback) + re-encrypt (current key only) round trip
// through these same two functions *is* the re-encryption operation, no
// need for a separate copy of the auth-shape-branching logic.
export function buildAuthConfig(auth: RemoteSourceAuthInput): Record<string, unknown> {
  const key = remoteSourceEncryptionKey();
  if (auth.authType === "api_key") {
    return { apiKeyEncrypted: encryptSecret(auth.apiKey, key), headerName: auth.headerName ?? "X-API-Key" };
  }
  if (auth.authType === "oauth2_client_credentials") {
    return {
      tokenUrl: auth.tokenUrl,
      clientId: auth.clientId,
      clientSecretEncrypted: encryptSecret(auth.clientSecret, key),
      scope: auth.scope ?? null,
    };
  }
  return { scriptBody: auth.scriptBody, envEncrypted: encryptSecret(JSON.stringify(auth.env), key) };
}

export function toAuth(authType: string, authConfig: Record<string, unknown>): RemoteSourceAuth {
  const key = remoteSourceEncryptionKey();
  const previousKey = remoteSourceEncryptionKeyPrevious();
  if (authType === "api_key") {
    return {
      authType: "api_key",
      apiKey: decryptSecretWithFallback(authConfig.apiKeyEncrypted as string, key, previousKey),
      headerName: (authConfig.headerName as string) ?? "X-API-Key",
    };
  }
  if (authType === "oauth2_client_credentials") {
    return {
      authType: "oauth2_client_credentials",
      tokenUrl: authConfig.tokenUrl as string,
      clientId: authConfig.clientId as string,
      clientSecret: decryptSecretWithFallback(
        authConfig.clientSecretEncrypted as string,
        key,
        previousKey
      ),
      scope: (authConfig.scope as string | null) ?? undefined,
    };
  }
  return {
    authType: "custom",
    scriptBody: authConfig.scriptBody as string,
    env: JSON.parse(decryptSecretWithFallback(authConfig.envEncrypted as string, key, previousKey)),
  };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export interface CreateRemoteSourceInput {
  name: string;
  baseUrl: string;
  pollIntervalMinutes: number;
  backfillFrom: string;
  auth: RemoteSourceAuthInput;
}

export async function listRemoteSources(): Promise<RemoteSourceMeta[]> {
  const rows = await query<RemoteSourceRow>(
    `SELECT ${REMOTE_SOURCE_COLUMNS} FROM remote_sources rs ORDER BY rs.name ASC`
  );
  return rows.map(toMeta);
}

export async function getRemoteSourceMeta(id: number): Promise<RemoteSourceMeta | null> {
  const row = await queryOne<RemoteSourceRow>(
    `SELECT ${REMOTE_SOURCE_COLUMNS} FROM remote_sources rs WHERE rs.id = $1`,
    [id]
  );
  return row ? toMeta(row) : null;
}

/** Encrypts secret fields before insert. Caller must have already checked encryptionConfigured(). */
export async function createRemoteSource(input: CreateRemoteSourceInput): Promise<RemoteSourceMeta> {
  const authConfig = buildAuthConfig(input.auth);
  const row = await queryOne<RemoteSourceRow>(
    `INSERT INTO remote_sources (name, base_url, auth_type, auth_config, poll_interval_minutes, backfill_from)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::text, name, base_url, auth_type, auth_config, enabled, poll_interval_minutes,
               backfill_from, watermark, last_polled_at, last_poll_status, last_poll_error,
               created_at, updated_at, 0 AS reject_count`,
    [
      input.name,
      input.baseUrl,
      input.auth.authType,
      JSON.stringify(authConfig),
      input.pollIntervalMinutes,
      input.backfillFrom,
    ]
  );
  return toMeta(row!);
}

export interface RemoteSourcePatch {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  pollIntervalMinutes?: number;
  /** Omitted = credential unchanged, same convention as UserPatch.password. */
  auth?: RemoteSourceAuthInput;
}

export async function updateRemoteSource(id: number, patch: RemoteSourcePatch): Promise<RemoteSourceMeta | null> {
  const { sets, params } = buildSetClause({
    name: patch.name,
    base_url: patch.baseUrl,
    enabled: patch.enabled,
    poll_interval_minutes: patch.pollIntervalMinutes,
    auth_type: patch.auth?.authType,
    auth_config: patch.auth !== undefined ? JSON.stringify(buildAuthConfig(patch.auth)) : undefined,
  });
  if (sets.length === 0) return getRemoteSourceMeta(id);

  sets.push("updated_at = now()");
  params.push(id);
  const row = await queryOne<RemoteSourceRow>(
    `UPDATE remote_sources rs SET ${sets.join(", ")} WHERE rs.id = $${params.length}
     RETURNING rs.id::text, rs.name, rs.base_url, rs.auth_type, rs.auth_config, rs.enabled,
               rs.poll_interval_minutes, rs.backfill_from, rs.watermark, rs.last_polled_at,
               rs.last_poll_status, rs.last_poll_error, rs.created_at, rs.updated_at,
               (SELECT COUNT(*)::int FROM remote_source_rejects r WHERE r.remote_source_id = rs.id) AS reject_count`,
    params
  );
  return row ? toMeta(row) : null;
}

export async function deleteRemoteSource(id: number): Promise<boolean> {
  const rows = await query<{ id: string }>("DELETE FROM remote_sources WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}

/** Includes decrypted credentials — only ever call this from the poller, never return it from a route. */
export interface RemoteSourceInternal extends RemoteSourceMeta {
  auth: RemoteSourceAuth;
}

export async function getRemoteSourceForPolling(id: number): Promise<RemoteSourceInternal | null> {
  const row = await queryOne<RemoteSourceRow>(
    `SELECT ${REMOTE_SOURCE_COLUMNS_FOR_POLLING} FROM remote_sources rs WHERE rs.id = $1`,
    [id]
  );
  if (!row) return null;
  return { ...toMeta(row), auth: toAuth(row.auth_type, row.auth_config) };
}

// ─── Poll bookkeeping ───────────────────────────────────────────────────────

export interface PollResultUpdate {
  /** Only set on a fully successful cycle — omit to leave the watermark unchanged (see remotePollService.ts). */
  watermark?: string;
  status: RemotePollStatus;
  error?: string | null;
}

export async function recordPollResult(id: number, result: PollResultUpdate): Promise<void> {
  const { sets, params } = buildSetClause({
    last_poll_status: result.status,
    last_poll_error: result.error ?? null,
    watermark: result.watermark,
  });
  sets.push("last_polled_at = now()", "updated_at = now()");
  params.push(id);
  await query(`UPDATE remote_sources SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
}

// ─── Rejects ────────────────────────────────────────────────────────────────

export interface RemoteSourceReject {
  id: number;
  remoteSourceId: number;
  occurredAt: string;
  callId: string | null;
  validationError: string;
  recordRaw: unknown;
}

interface RemoteSourceRejectRow {
  id: string;
  remote_source_id: string;
  occurred_at: string;
  call_id: string | null;
  validation_error: string;
  record_raw: unknown;
}

function toReject(row: RemoteSourceRejectRow): RemoteSourceReject {
  return {
    id: parseInt(row.id, 10),
    remoteSourceId: parseInt(row.remote_source_id, 10),
    occurredAt: toIso(row.occurred_at),
    callId: row.call_id,
    validationError: row.validation_error,
    recordRaw: row.record_raw,
  };
}

export async function logRemoteSourceReject(
  remoteSourceId: number,
  callId: string | null,
  validationError: string,
  recordRaw: unknown
): Promise<void> {
  await query(
    `INSERT INTO remote_source_rejects (remote_source_id, call_id, validation_error, record_raw)
     VALUES ($1, $2, $3, $4)`,
    [remoteSourceId, callId, validationError, JSON.stringify(recordRaw)]
  );
}

export interface RemoteSourceRejectPage {
  data: RemoteSourceReject[];
  pagination: { page: number; pageSize: number; totalPages: number; totalRecords: number };
}

export async function listRemoteSourceRejects(
  remoteSourceId: number,
  page: number,
  pageSize: number
): Promise<RemoteSourceRejectPage> {
  const countRow = await queryOne<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM remote_source_rejects WHERE remote_source_id = $1`,
    [remoteSourceId]
  );
  const totalRecords = parseInt(countRow?.total ?? "0", 10);
  const limit = pageSize;
  const offset = (page - 1) * pageSize;
  const rows = await query<RemoteSourceRejectRow>(
    `SELECT id::text, remote_source_id::text, occurred_at, call_id, validation_error, record_raw
       FROM remote_source_rejects
      WHERE remote_source_id = $1
      ORDER BY occurred_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [remoteSourceId, limit, offset]
  );
  return {
    data: rows.map(toReject),
    pagination: { page, pageSize, totalPages: Math.max(1, Math.ceil(totalRecords / pageSize)), totalRecords },
  };
}

/** Deletes reject entries older than retentionDays. Run on boot and daily thereafter. */
export async function pruneRemoteSourceRejects(retentionDays: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM remote_source_rejects WHERE occurred_at < now() - ($1 || ' days')::interval RETURNING id`,
    [retentionDays]
  );
  return rows.length;
}
