import { callRecordSchema, type CallRecordInput } from "../schemas/cdr";
import { ingestRecords } from "./ingestService";
import { getAuthHeader } from "./remoteAuthService";
import { runCustomScript } from "./remoteScriptRunner";
import { tryClaimJob } from "../db/jobLock";
import {
  getRemoteSourceForPolling,
  recordPollResult,
  logRemoteSourceReject,
  type RemoteSourceInternal,
  type RemotePollStatus,
} from "./remoteSourceService";

const PAGE_SIZE = 1000;
// A misbehaving/hostile remote returning a totalPages that never resolves
// correctly shouldn't stall the shared polling tick (see index.ts) forever —
// cap and surface it as a fetch error instead of looping indefinitely.
const MAX_PAGES_PER_CYCLE = 500;
// Node's native fetch has no default timeout; a hung remote would otherwise
// block this source's poll (and only this source's, since polling is
// sequential) indefinitely.
const REQUEST_TIMEOUT_MS = 30_000;

class RemoteAuthError extends Error {}

export interface PollSummary {
  sourceId: number;
  pagesRead: number;
  accepted: number;
  rejected: number;
  status: RemotePollStatus;
  watermark: string | null;
  error?: string;
}

interface RemoteCallsPage {
  data: unknown[];
  pagination: { page: number; pageSize: number; totalPages: number; totalRecords: number };
}

function extractCallId(raw: unknown): string | null {
  if (raw && typeof raw === "object" && typeof (raw as { callId?: unknown }).callId === "string") {
    return (raw as { callId: string }).callId;
  }
  return null;
}

/**
 * Validates each record individually (not ingestBodySchema.parse(wholeArray)
 * the way POST /calls/ingest does — a single malformed record shouldn't block
 * every valid one alongside it), ingests accepted records immediately, and
 * logs rejects to remote_source_rejects. Shared by both the HTTP-pagination
 * path (per page) and the custom-script path (once, on the script's full
 * output) so the two source-type families get identical validation/ingest/
 * reject behavior.
 */
async function validateAndIngestBatch(
  sourceId: number,
  rawRecords: unknown[]
): Promise<{ accepted: number; rejected: number }> {
  const accepted: CallRecordInput[] = [];
  let rejected = 0;
  for (const raw of rawRecords) {
    const parsed = callRecordSchema.safeParse(raw);
    if (parsed.success) {
      accepted.push(parsed.data);
    } else {
      rejected++;
      await logRemoteSourceReject(sourceId, extractCallId(raw), JSON.stringify(parsed.error.format()), raw);
    }
  }
  // Ingest immediately rather than letting the caller accumulate across a
  // wider boundary — for the paginated HTTP path this means a later page's
  // failure can't undo an earlier page's already-durable progress (upsert is
  // idempotent by callId, so re-covering the same window on retry is
  // harmless); for the custom-script path there's only one batch anyway.
  if (accepted.length > 0) {
    await ingestRecords(accepted);
  }
  return { accepted: accepted.length, rejected };
}

async function fetchPage(
  source: RemoteSourceInternal,
  startTime: string,
  endTime: string,
  page: number,
  headers: Record<string, string>
): Promise<RemoteCallsPage> {
  const url = new URL(`${source.baseUrl.replace(/\/$/, "")}/calls`);
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(PAGE_SIZE));

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 401 || res.status === 403) {
    throw new RemoteAuthError(`Remote returned ${res.status} for ${url.pathname}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Remote GET /calls failed: ${res.status} ${detail}`.trim());
  }
  const body = (await res.json()) as Partial<RemoteCallsPage>;
  if (!Array.isArray(body.data) || !body.pagination) {
    throw new Error("Remote /calls response is missing data[]/pagination — not an Open-CDR-compatible response");
  }
  return body as RemoteCallsPage;
}

/**
 * Pulls one cycle's worth of records from a remote source. Two families:
 * 'custom' runs the admin's own script once (see remoteScriptRunner.ts —
 * connect/scan/parse/map is entirely the script's job, no pagination since
 * the script decides how much to return in one run); 'api_key'/
 * 'oauth2_client_credentials' paginate GET {baseUrl}/calls for
 * [watermark ?? backfillFrom, pollStartTime) same as before. Both funnel
 * through validateAndIngestBatch for identical validation/ingest/reject
 * behavior, and both advance the watermark on success / leave it untouched
 * on failure (upsert is idempotent by callId, so a retry re-covering the
 * same window on failure is harmless).
 */
async function pollRemoteSourceImpl(sourceId: number): Promise<PollSummary> {
  const source = await getRemoteSourceForPolling(sourceId);
  if (!source) throw new Error(`Remote source ${sourceId} not found`);

  const pollStartTime = new Date();
  const startTime = source.watermark ?? source.backfillFrom;
  const endTime = pollStartTime.toISOString();

  let acceptedCount = 0;
  let rejectedCount = 0;
  let pagesRead = 0;
  let watermark = endTime;

  try {
    if (source.auth.authType === "custom") {
      const result = await runCustomScript({ ...source, auth: source.auth });
      pagesRead = 1;
      const batch = await validateAndIngestBatch(sourceId, result.records);
      acceptedCount = batch.accepted;
      rejectedCount = batch.rejected;
      // Script-reported watermark wins when present — it knows exactly what
      // it actually processed (e.g. which SFTP files); poll-start-time is
      // only a fallback for a script that doesn't report one.
      watermark = result.watermark ?? endTime;
    } else {
      const headers = await getAuthHeader(sourceId, source.auth);

      let page = 1;
      for (;;) {
        if (page > MAX_PAGES_PER_CYCLE) {
          throw new Error(
            `Stopped after ${MAX_PAGES_PER_CYCLE} pages — window likely too wide, check backfillFrom or shrink the poll interval`
          );
        }

        const result = await fetchPage(source, startTime, endTime, page, headers);
        pagesRead++;

        const batch = await validateAndIngestBatch(sourceId, result.data);
        acceptedCount += batch.accepted;
        rejectedCount += batch.rejected;

        if (page >= result.pagination.totalPages) break;
        page++;
      }
      // Advance to the poll's own start time, not the max lastUpdateTime
      // seen — guarantees no gap for a record updated between the last page
      // fetch and now.
      watermark = endTime;
    }

    // A reject doesn't block the watermark either; a bad record shouldn't
    // cause the whole window to be retried forever.
    const status: RemotePollStatus = rejectedCount > 0 ? "validation_rejects" : "ok";
    await recordPollResult(sourceId, { watermark, status });
    return { sourceId, pagesRead, accepted: acceptedCount, rejected: rejectedCount, status, watermark };
  } catch (err) {
    const status: RemotePollStatus = err instanceof RemoteAuthError ? "auth_error" : "fetch_error";
    const message = err instanceof Error ? err.message : String(err);
    // Watermark deliberately NOT advanced — next cycle re-covers the whole
    // window, including whatever page failed.
    await recordPollResult(sourceId, { status, error: message });
    return {
      sourceId,
      pagesRead,
      accepted: acceptedCount,
      rejected: rejectedCount,
      status,
      watermark: null,
      error: message,
    };
  }
}

// Keyed by sourceId — the 60s background tick (index.ts's pollDueRemoteSources)
// and an on-demand POST /admin/remote-sources/:id/poll can otherwise race:
// confirmed by testing that a never-polled, enabled source picked up by both
// in the same window ran two fully concurrent script executions (and kept
// accumulating a new pair every further 60s tick, since last_polled_at stays
// null — "never polled" — until the first one finally completes). Harmless
// for the idempotent-by-callId HTTP paths beyond wasted work, but a real
// problem for 'custom' sources whose script may have non-idempotent side
// effects (e.g. deleting files off an SFTP server once processed). A caller
// that arrives while a poll for the same source is already running gets that
// same in-flight result instead of starting a second, duplicate execution.
//
// This only guards callers within *this* process, though — across replicas,
// REMOTE_SOURCE_POLL_LEASE_MS below (via tryClaimJob) guards against a
// different instance already polling the same source.
const inFlightPolls = new Map<number, Promise<PollSummary>>();

// Generous: covers a 'custom' script's own SCRIPT_TIMEOUT_MS + SCRIPT_KILL_GRACE_MS
// (125s, remoteScriptRunner.ts) with headroom, and the HTTP path's slower but
// still bounded worst case (MAX_PAGES_PER_CYCLE pages at up to REQUEST_TIMEOUT_MS
// each). If a claiming replica dies mid-poll, another replica can pick the
// source back up once this lease expires rather than waiting indefinitely.
const REMOTE_SOURCE_POLL_LEASE_MS = 10 * 60_000;

export function pollRemoteSource(sourceId: number): Promise<PollSummary> {
  const existing = inFlightPolls.get(sourceId);
  if (existing) return existing;

  const run = (async (): Promise<PollSummary> => {
    const claimed = await tryClaimJob(
      `remote_source_poll:${sourceId}`,
      REMOTE_SOURCE_POLL_LEASE_MS
    );
    if (!claimed) {
      return {
        sourceId,
        pagesRead: 0,
        accepted: 0,
        rejected: 0,
        status: "skipped_locked",
        watermark: null,
        error: "Another instance is already polling this source",
      };
    }
    return pollRemoteSourceImpl(sourceId);
  })().finally(() => {
    inFlightPolls.delete(sourceId);
  });
  inFlightPolls.set(sourceId, run);
  return run;
}
