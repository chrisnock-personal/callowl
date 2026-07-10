import { query, queryOne } from "../db/pool";
import type {
  StatisticsSummary,
  MediaTypeStat,
  ComponentStat,
  VoiceBreakdown,
  AverageDurations,
} from "../types";

export interface StatsFilters {
  startTime: string;
  endTime: string;
  tenantId?: string;
  groups?: string[];
  sourcePlatformId?: string[];
}

/**
 * Shared filter set for the insights endpoints (top talkers, throughput) — both
 * are platform extensions, not part of the standard's documented API, so they
 * reuse the same window + read-API filters as GET /calls (minus pagination and
 * participant search, which don't apply to an aggregate).
 */
export interface InsightsFilters {
  startTime: string;
  endTime: string;
  mediaType?: string[];
  groups?: string[];
  excludeGroups?: string[];
  tenantId?: string;
  sourcePlatformId?: string[];
}

function insightsWhere(f: InsightsFilters): { sql: string; params: unknown[] } {
  const where: string[] = ["order_time >= $1", "order_time < $2"];
  const params: unknown[] = [f.startTime, f.endTime];

  if (f.mediaType && f.mediaType.length) {
    params.push(f.mediaType);
    where.push(`media_type = ANY($${params.length})`);
  }
  // Defined-but-empty groups/sourcePlatformId means "matches nothing" (see
  // cdrService.listCallRecords) — only reachable via access scoping, where a
  // scoped user's allowed set can intersect an out-of-scope request to [].
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

  return { sql: where.join(" AND "), params };
}

export interface PlatformBreakdownPoint {
  sourcePlatformId: string | null;
  count: number;
}

/**
 * GET /statistics/by-platform (platform extension) — call counts grouped by
 * sourcePlatformId. Records without one (ingested before the field existed, or
 * simply not supplied) group under a null bucket the caller renders as
 * "Unknown platform".
 */
export async function getPlatformBreakdown(
  f: InsightsFilters
): Promise<PlatformBreakdownPoint[]> {
  const { sql: where, params } = insightsWhere(f);
  const rows = await query<{ source_platform_id: string | null; n: string }>(
    `SELECT source_platform_id, COUNT(*)::text AS n
       FROM call_records
      WHERE ${where}
      GROUP BY source_platform_id
      ORDER BY COUNT(*) DESC`,
    params
  );
  return rows.map((r) => ({
    sourcePlatformId: r.source_platform_id,
    count: parseInt(r.n, 10),
  }));
}

export interface ThroughputPoint {
  bucketStart: string;
  count: number;
}

/** GET /statistics/throughput (platform extension) — call volume bucketed by hour or day. */
export async function getThroughput(
  f: InsightsFilters,
  bucket: "hour" | "day"
): Promise<ThroughputPoint[]> {
  const { sql: where, params } = insightsWhere(f);
  params.push(bucket);
  const rows = await query<{ bucket_start: string; n: string }>(
    `SELECT date_trunc($${params.length}, order_time) AS bucket_start, COUNT(*)::text AS n
       FROM call_records
      WHERE ${where}
      GROUP BY bucket_start
      ORDER BY bucket_start ASC`,
    params
  );
  return rows.map((r) => ({
    bucketStart: new Date(r.bucket_start).toISOString(),
    count: parseInt(r.n, 10),
  }));
}

export interface ThroughputOutcomePoint {
  bucketStart: string;
  answered: number;
  unanswered: number;
}

/**
 * GET /statistics/throughput/by-outcome (platform extension) — call volume
 * bucketed by hour or day, split answered ("ended") vs unanswered ("missed" or
 * "abandoned"). Ongoing calls count toward neither, so a bucket's two figures
 * can sum to slightly less than the equivalent GET /statistics/throughput count.
 */
export async function getThroughputByOutcome(
  f: InsightsFilters,
  bucket: "hour" | "day"
): Promise<ThroughputOutcomePoint[]> {
  const { sql: where, params } = insightsWhere(f);
  params.push(bucket);
  const rows = await query<{ bucket_start: string; answered: string; unanswered: string }>(
    `SELECT date_trunc($${params.length}, order_time) AS bucket_start,
            COUNT(*) FILTER (WHERE call_state = 'ended')::text AS answered,
            COUNT(*) FILTER (WHERE call_state IN ('missed', 'abandoned'))::text AS unanswered
       FROM call_records
      WHERE ${where}
      GROUP BY bucket_start
      ORDER BY bucket_start ASC`,
    params
  );
  return rows.map((r) => ({
    bucketStart: new Date(r.bucket_start).toISOString(),
    answered: parseInt(r.answered, 10),
    unanswered: parseInt(r.unanswered, 10),
  }));
}

export interface TopTalker {
  identity: string;
  displayName: string | null;
  isInternal: boolean;
  callCount: number;
  totalDurationSeconds: number;
}

export type TalkerScope = "internal" | "external" | "all";

// Roles that represent system components rather than a person on the call —
// excluded so "top talkers" reflects people, matching byComponent's coverage
// of ivr/queue instead of double-counting them here.
const NON_TALKER_ROLES = ["ivr", "queue", "voicemail", "unknown"];

/**
 * GET /statistics/top-talkers (platform extension) — participants ranked by call
 * count. "Internal" means the participant carried a userId on at least one call
 * (an agent/user known to the switch); "external" means every appearance of that
 * identity was extension-only (e.g. an outside caller's number).
 */
export async function getTopTalkers(
  f: InsightsFilters,
  limit: number,
  scope: TalkerScope = "all"
): Promise<TopTalker[]> {
  const { sql: where, params } = insightsWhere(f);
  params.push(NON_TALKER_ROLES);
  const roleParamIdx = params.length;
  params.push(limit);
  const limitParamIdx = params.length;

  const having =
    scope === "internal"
      ? "HAVING BOOL_OR(has_user_id) = TRUE"
      : scope === "external"
      ? "HAVING BOOL_OR(has_user_id) = FALSE"
      : "";

  const rows = await query<{
    identity: string;
    display_name: string | null;
    is_internal: boolean;
    call_count: string;
    total_duration_seconds: string | null;
  }>(
    `WITH pt AS (
       SELECT DISTINCT cr.id, cr.duration_seconds,
              COALESCE(p->>'userId', p->>'extension') AS identity,
              p->>'displayName' AS display_name,
              (p->>'userId' IS NOT NULL) AS has_user_id
         FROM call_records cr, jsonb_array_elements(cr.record->'participants') AS p
        WHERE ${where}
          AND NOT (p->>'role' = ANY($${roleParamIdx}))
     )
     SELECT identity, MAX(display_name) AS display_name,
            BOOL_OR(has_user_id) AS is_internal,
            COUNT(*)::text AS call_count,
            SUM(duration_seconds)::text AS total_duration_seconds
       FROM pt
      WHERE identity IS NOT NULL AND identity <> ''
      GROUP BY identity
      ${having}
      ORDER BY COUNT(*) DESC, SUM(duration_seconds) DESC NULLS LAST
      LIMIT $${limitParamIdx}`,
    params
  );

  return rows.map((r) => ({
    identity: r.identity,
    displayName: r.display_name,
    isInternal: r.is_internal,
    callCount: parseInt(r.call_count, 10),
    totalDurationSeconds: r.total_duration_seconds
      ? Math.round(parseFloat(r.total_duration_seconds))
      : 0,
  }));
}

export interface HandleTimeTrendPoint {
  bucketStart: string;
  avgSeconds: number;
  callCount: number;
}

/** GET /statistics/handle-time (platform extension) — avg call duration bucketed by hour or day. */
export async function getHandleTimeTrend(
  f: InsightsFilters,
  bucket: "hour" | "day"
): Promise<HandleTimeTrendPoint[]> {
  const { sql: where, params } = insightsWhere(f);
  params.push(bucket);
  const rows = await query<{ bucket_start: string; avg_seconds: string | null; n: string }>(
    `SELECT date_trunc($${params.length}, order_time) AS bucket_start,
            AVG(duration_seconds)::text AS avg_seconds,
            COUNT(*)::text AS n
       FROM call_records
      WHERE ${where} AND duration_seconds IS NOT NULL
      GROUP BY bucket_start
      ORDER BY bucket_start ASC`,
    params
  );
  return rows.map((r) => ({
    bucketStart: new Date(r.bucket_start).toISOString(),
    avgSeconds: r.avg_seconds ? Math.round(parseFloat(r.avg_seconds)) : 0,
    callCount: parseInt(r.n, 10),
  }));
}

export interface AgentHandleTime {
  identity: string;
  displayName: string | null;
  callCount: number;
  avgDurationSeconds: number;
}

/**
 * GET /statistics/handle-time/by-agent (platform extension) — agents (participants
 * who carried a userId) ranked by average call duration, longest first. Agents
 * with only a single call are excluded so one long outlier can't top the list.
 */
export async function getAgentHandleTime(
  f: InsightsFilters,
  limit: number
): Promise<AgentHandleTime[]> {
  const { sql: where, params } = insightsWhere(f);
  params.push(NON_TALKER_ROLES);
  const roleParamIdx = params.length;
  params.push(limit);
  const limitParamIdx = params.length;

  const rows = await query<{
    identity: string;
    display_name: string | null;
    call_count: string;
    avg_duration_seconds: string | null;
  }>(
    `WITH pt AS (
       SELECT DISTINCT cr.id, cr.duration_seconds,
              COALESCE(p->>'userId', p->>'extension') AS identity,
              p->>'displayName' AS display_name,
              (p->>'userId' IS NOT NULL) AS has_user_id
         FROM call_records cr, jsonb_array_elements(cr.record->'participants') AS p
        WHERE ${where}
          AND NOT (p->>'role' = ANY($${roleParamIdx}))
          AND cr.duration_seconds IS NOT NULL
     )
     SELECT identity, MAX(display_name) AS display_name,
            COUNT(*)::text AS call_count,
            AVG(duration_seconds)::text AS avg_duration_seconds
       FROM pt
      WHERE identity IS NOT NULL AND identity <> '' AND has_user_id = TRUE
      GROUP BY identity
     HAVING COUNT(*) >= 2
      ORDER BY AVG(duration_seconds) DESC
      LIMIT $${limitParamIdx}`,
    params
  );

  return rows.map((r) => ({
    identity: r.identity,
    displayName: r.display_name,
    callCount: parseInt(r.call_count, 10),
    avgDurationSeconds: r.avg_duration_seconds ? Math.round(parseFloat(r.avg_duration_seconds)) : 0,
  }));
}

export interface QueueWaitTrendPoint {
  bucketStart: string;
  avgSeconds: number;
  callCount: number;
}

/**
 * GET /statistics/queue-wait (platform extension) — avg time in queue
 * (callSource.timeInQueueSeconds) bucketed by hour or day. Only counts calls
 * that actually passed through a queue.
 */
export async function getQueueWaitTrend(
  f: InsightsFilters,
  bucket: "hour" | "day"
): Promise<QueueWaitTrendPoint[]> {
  const { sql: where, params } = insightsWhere(f);
  params.push(bucket);
  const rows = await query<{ bucket_start: string; avg_seconds: string | null; n: string }>(
    `SELECT date_trunc($${params.length}, order_time) AS bucket_start,
            AVG((record->'callSource'->>'timeInQueueSeconds')::numeric)::text AS avg_seconds,
            COUNT(*)::text AS n
       FROM call_records
      WHERE ${where} AND record->'callSource'->>'timeInQueueSeconds' IS NOT NULL
      GROUP BY bucket_start
      ORDER BY bucket_start ASC`,
    params
  );
  return rows.map((r) => ({
    bucketStart: new Date(r.bucket_start).toISOString(),
    avgSeconds: r.avg_seconds ? Math.round(parseFloat(r.avg_seconds)) : 0,
    callCount: parseInt(r.n, 10),
  }));
}

export interface QueueWaitBreakdown {
  queueId: string;
  callCount: number;
  avgWaitSeconds: number;
}

/** GET /statistics/queue-wait/by-queue (platform extension) — queues ranked by average wait, longest first. */
export async function getQueueWaitBreakdown(
  f: InsightsFilters,
  limit: number
): Promise<QueueWaitBreakdown[]> {
  const { sql: where, params } = insightsWhere(f);
  params.push(limit);
  const limitParamIdx = params.length;

  const rows = await query<{ queue_id: string; call_count: string; avg_wait_seconds: string | null }>(
    `SELECT record->'callSource'->>'queueInfo' AS queue_id,
            COUNT(*)::text AS call_count,
            AVG((record->'callSource'->>'timeInQueueSeconds')::numeric)::text AS avg_wait_seconds
       FROM call_records
      WHERE ${where}
        AND record->'callSource'->>'queueInfo' IS NOT NULL
        AND record->'callSource'->>'timeInQueueSeconds' IS NOT NULL
      GROUP BY queue_id
      ORDER BY AVG((record->'callSource'->>'timeInQueueSeconds')::numeric) DESC
      LIMIT $${limitParamIdx}`,
    params
  );

  return rows.map((r) => ({
    queueId: r.queue_id,
    callCount: parseInt(r.call_count, 10),
    avgWaitSeconds: r.avg_wait_seconds ? Math.round(parseFloat(r.avg_wait_seconds)) : 0,
  }));
}

export interface WorstMosCall {
  callId: string;
  mosScore: number;
  startTime: string;
  durationSeconds: number | null;
}

/**
 * GET /statistics/worst-mos (platform extension) — voice calls with the lowest
 * MOS (Mean Opinion Score) in the window, worst first. Surfaces degraded-quality
 * calls that would otherwise only be visible one-by-one in the detail drawer.
 */
export async function getWorstMosCalls(
  f: InsightsFilters,
  limit: number
): Promise<WorstMosCall[]> {
  const { sql: where, params } = insightsWhere(f);
  params.push(limit);
  const limitParamIdx = params.length;

  const rows = await query<{
    call_id: string;
    mos_score: string;
    call_start_time: string;
    duration_seconds: string | null;
  }>(
    `SELECT call_id,
            (record->'qos'->>'mosScore')::text AS mos_score,
            call_start_time::text AS call_start_time,
            duration_seconds::text AS duration_seconds
       FROM call_records
      WHERE ${where} AND record->'qos'->>'mosScore' IS NOT NULL
      ORDER BY (record->'qos'->>'mosScore')::numeric ASC
      LIMIT $${limitParamIdx}`,
    params
  );

  return rows.map((r) => ({
    callId: r.call_id,
    mosScore: parseFloat(r.mos_score),
    startTime: new Date(r.call_start_time).toISOString(),
    durationSeconds: r.duration_seconds ? Math.round(parseFloat(r.duration_seconds)) : null,
  }));
}

export interface IvrTimeTrendPoint {
  bucketStart: string;
  avgSeconds: number;
  callCount: number;
}

/**
 * GET /statistics/ivr-time (platform extension) — avg time in IVR
 * (callSource.timeInIvrSeconds) bucketed by hour or day. Only counts calls
 * that actually passed through an IVR.
 */
export async function getIvrTimeTrend(
  f: InsightsFilters,
  bucket: "hour" | "day"
): Promise<IvrTimeTrendPoint[]> {
  const { sql: where, params } = insightsWhere(f);
  params.push(bucket);
  const rows = await query<{ bucket_start: string; avg_seconds: string | null; n: string }>(
    `SELECT date_trunc($${params.length}, order_time) AS bucket_start,
            AVG((record->'callSource'->>'timeInIvrSeconds')::numeric)::text AS avg_seconds,
            COUNT(*)::text AS n
       FROM call_records
      WHERE ${where} AND record->'callSource'->>'timeInIvrSeconds' IS NOT NULL
      GROUP BY bucket_start
      ORDER BY bucket_start ASC`,
    params
  );
  return rows.map((r) => ({
    bucketStart: new Date(r.bucket_start).toISOString(),
    avgSeconds: r.avg_seconds ? Math.round(parseFloat(r.avg_seconds)) : 0,
    callCount: parseInt(r.n, 10),
  }));
}

export interface IvrBreakdown {
  ivrId: string;
  callCount: number;
  avgTimeSeconds: number;
}

/** GET /statistics/ivr-time/by-ivr (platform extension) — IVRs ranked by average traversal time, longest first. */
export async function getIvrTimeByIvr(
  f: InsightsFilters,
  limit: number
): Promise<IvrBreakdown[]> {
  const { sql: where, params } = insightsWhere(f);
  params.push(limit);
  const limitParamIdx = params.length;

  const rows = await query<{ ivr_id: string; call_count: string; avg_time_seconds: string | null }>(
    `SELECT record->'callSource'->>'ivrInfo' AS ivr_id,
            COUNT(*)::text AS call_count,
            AVG((record->'callSource'->>'timeInIvrSeconds')::numeric)::text AS avg_time_seconds
       FROM call_records
      WHERE ${where}
        AND record->'callSource'->>'ivrInfo' IS NOT NULL
        AND record->'callSource'->>'timeInIvrSeconds' IS NOT NULL
      GROUP BY ivr_id
      ORDER BY AVG((record->'callSource'->>'timeInIvrSeconds')::numeric) DESC
      LIMIT $${limitParamIdx}`,
    params
  );

  return rows.map((r) => ({
    ivrId: r.ivr_id,
    callCount: parseInt(r.call_count, 10),
    avgTimeSeconds: r.avg_time_seconds ? Math.round(parseFloat(r.avg_time_seconds)) : 0,
  }));
}

/**
 * GET /statistics/summary. Aggregates the stored records in the window into the
 * standard's StatisticsSummary. Component and abandonment breakdowns are derived
 * best-effort from callSource (ivrInfo / queueInfo) and call_state, since those
 * are the routing signals the standard exposes.
 */
export async function getStatisticsSummary(
  f: StatsFilters
): Promise<StatisticsSummary> {
  const win = ["order_time >= $1", "order_time < $2"];
  const params: unknown[] = [f.startTime, f.endTime];
  if (f.tenantId) {
    params.push(f.tenantId);
    win.push(`tenant_id = $${params.length}`);
  }
  if (f.groups !== undefined) {
    params.push(f.groups);
    win.push(`groups && $${params.length}`);
  }
  if (f.sourcePlatformId !== undefined) {
    params.push(f.sourcePlatformId);
    win.push(`source_platform_id = ANY($${params.length})`);
  }
  const where = win.join(" AND ");

  const byMediaType = await query<{ media_type: string; n: string }>(
    `SELECT media_type, COUNT(*)::text AS n
       FROM call_records WHERE ${where}
      GROUP BY media_type ORDER BY media_type`,
    params
  );

  const voice = await queryOne<{
    matured: string;
    unmatured: string;
    ab_ivr: string;
    ab_queue: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE media_type='voice' AND call_state='ended')::text AS matured,
       COUNT(*) FILTER (WHERE media_type='voice' AND call_state IN ('missed','abandoned'))::text AS unmatured,
       COUNT(*) FILTER (WHERE media_type='voice' AND call_state='abandoned'
                          AND record->'callSource'->>'ivrInfo'   IS NOT NULL
                          AND record->'callSource'->>'queueInfo' IS NULL)::text AS ab_ivr,
       COUNT(*) FILTER (WHERE media_type='voice' AND call_state='abandoned'
                          AND record->'callSource'->>'queueInfo' IS NOT NULL)::text AS ab_queue
     FROM call_records WHERE ${where}`,
    params
  );

  const avg = await queryOne<{
    ivr: string | null;
    queue: string | null;
    agent: string | null;
    total: string | null;
  }>(
    `SELECT
       AVG((record->'callSource'->>'timeInIvrSeconds')::numeric)::text   AS ivr,
       AVG((record->'callSource'->>'timeInQueueSeconds')::numeric)::text AS queue,
       AVG(duration_seconds)::text AS agent,
       AVG(EXTRACT(EPOCH FROM (
             COALESCE(interaction_end_time, call_end_time)
           - COALESCE(interaction_start_time, call_start_time)
         )))::text AS total
     FROM call_records WHERE ${where}`,
    params
  );

  // Components: ACD queues and IVRs named in callSource, plus logical groups.
  const components = await query<{
    component_type: string;
    component_id: string;
    n: string;
  }>(
    `SELECT component_type, component_id, COUNT(*)::text AS n FROM (
        SELECT 'acd'  AS component_type, record->'callSource'->>'queueInfo' AS component_id
          FROM call_records WHERE ${where} AND record->'callSource'->>'queueInfo' IS NOT NULL
        UNION ALL
        SELECT 'ivr'  AS component_type, record->'callSource'->>'ivrInfo' AS component_id
          FROM call_records WHERE ${where} AND record->'callSource'->>'ivrInfo' IS NOT NULL
        UNION ALL
        SELECT 'group' AS component_type, g AS component_id
          FROM call_records, UNNEST(groups) AS g WHERE ${where}
     ) src
     GROUP BY component_type, component_id
     ORDER BY component_type, component_id`,
    params
  );

  const num = (v: string | null | undefined) =>
    v == null ? 0 : Math.round(parseFloat(v) * 100) / 100;

  const byMediaTypeStat: MediaTypeStat[] = byMediaType.map((r) => ({
    mediaType: r.media_type as MediaTypeStat["mediaType"],
    totalInteractions: parseInt(r.n, 10),
  }));

  const byComponentStat: ComponentStat[] = components.map((r) => ({
    componentType: r.component_type as ComponentStat["componentType"],
    componentId: r.component_id,
    totalInteractions: parseInt(r.n, 10),
  }));

  const voiceBreakdown: VoiceBreakdown = {
    maturedAnswered: parseInt(voice?.matured ?? "0", 10),
    unmaturedUnanswered: parseInt(voice?.unmatured ?? "0", 10),
    abandonedDuringIvr: parseInt(voice?.ab_ivr ?? "0", 10),
    abandonedDuringQueue: parseInt(voice?.ab_queue ?? "0", 10),
  };

  const averageDurations: AverageDurations = {
    avgTimeInIvrSeconds: num(avg?.ivr),
    avgTimeInQueueSeconds: num(avg?.queue),
    avgTimeWithAgentSeconds: num(avg?.agent),
    avgTotalInteractionSeconds: num(avg?.total),
  };

  return {
    periodStart: f.startTime,
    periodEnd: f.endTime,
    byComponent: byComponentStat,
    byMediaType: byMediaTypeStat,
    voiceBreakdown,
    averageDurations,
  };
}
