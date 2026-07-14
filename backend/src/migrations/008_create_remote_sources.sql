-- ─────────────────────────────────────────────────────────────────────────────
-- remote_sources
--
-- Admin-managed config for pulling CDRs from another Open-CDR-compatible
-- platform's own GET /calls, rather than only ever receiving pushed ingest
-- (POST /calls/ingest). Polled in-process on a setInterval (see index.ts),
-- same reasoning as pruneAuditLog not needing a separate sidecar service —
-- polling a remote HTTP API needs no special binary, unlike the `backup`
-- compose service which exists only because it needs pg_dump/pg_restore.
--
-- auth_config is JSONB whose shape depends on auth_type ('api_key' or
-- 'oauth2_client_credentials'); any secret field inside (apiKeyEncrypted /
-- clientSecretEncrypted) is sealed via services/cryptoService.ts, not this
-- table's own concern — clientId/tokenUrl/headerName stay plaintext since
-- they aren't sensitive on their own.
--
-- watermark is the cursor for the next poll's startTime — advanced to the
-- poll's own start time (not the max lastUpdateTime seen in the response) on
-- full success, so a record updated between the last page fetch and the poll
-- finishing can't be permanently skipped; upsert-by-callId makes the resulting
-- overlap harmless. Left NULL until a source's first poll, which starts from
-- backfill_from instead (required at creation — an unbounded default first
-- pull could otherwise miss history or be enormous depending on the remote's
-- retention).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS remote_sources (
  id                     BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                   TEXT        NOT NULL,
  base_url               TEXT        NOT NULL,
  auth_type              TEXT        NOT NULL, -- 'api_key' | 'oauth2_client_credentials'
  auth_config            JSONB       NOT NULL,
  enabled                BOOLEAN     NOT NULL DEFAULT true,
  poll_interval_minutes  INT         NOT NULL DEFAULT 15,
  backfill_from          TIMESTAMPTZ NOT NULL,
  watermark              TIMESTAMPTZ,
  last_polled_at         TIMESTAMPTZ,
  last_poll_status       TEXT, -- 'ok' | 'auth_error' | 'fetch_error' | 'validation_rejects'
  last_poll_error        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_remote_sources_enabled ON remote_sources (enabled);

-- ─────────────────────────────────────────────────────────────────────────────
-- remote_source_rejects
--
-- Per-record rejection log for pulled records that fail the same
-- callRecordSchema gate pushed ingest uses. Deliberately per-record, not
-- whole-batch-atomic like POST /calls/ingest — a single malformed record from
-- a remote page shouldn't block every valid record in that same page (see
-- services/remotePollService.ts). record_raw stores the offending JSON as
-- received so an operator can see exactly why it failed without re-fetching.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS remote_source_rejects (
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  remote_source_id  BIGINT      NOT NULL REFERENCES remote_sources(id) ON DELETE CASCADE,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  call_id           TEXT, -- best-effort extraction; may be null if even callId is missing/malformed
  validation_error  TEXT        NOT NULL,
  record_raw        JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_remote_source_rejects_source ON remote_source_rejects (remote_source_id);
CREATE INDEX IF NOT EXISTS ix_remote_source_rejects_occurred_at ON remote_source_rejects (occurred_at);
