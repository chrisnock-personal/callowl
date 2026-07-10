-- ─────────────────────────────────────────────────────────────────────────────
-- call_records
--
-- One row per Call Detail Record (one interaction leg / session), conforming to
-- the Open CDR Standard (cdr-schema.yaml → components.schemas.CallRecord).
--
-- Design: the full, spec-compliant CallRecord is stored verbatim in the JSONB
-- `record` column so nothing is lost and responses are byte-for-byte faithful to
-- the standard. The scalar columns are projections of that record, extracted at
-- ingest time purely to make the API's documented filters (time window, media
-- type, groups, tenant) fast and indexable. `groups` is denormalised from the
-- distinct participants[].group values so group include/exclude filtering is a
-- single array-overlap test.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_records (
  id                      BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  call_id                 TEXT        NOT NULL,
  parent_call_id          TEXT,
  tenant_id               TEXT,

  -- Timing (all UTC)
  interaction_start_time  TIMESTAMPTZ,
  call_start_time         TIMESTAMPTZ NOT NULL,
  call_end_time           TIMESTAMPTZ,             -- NULL implies ongoing
  interaction_end_time    TIMESTAMPTZ,
  last_update_time        TIMESTAMPTZ,
  duration_seconds        NUMERIC,

  -- Ordering key per spec: lastUpdateTime, falling back to endTime then startTime.
  -- Stored so the documented "ordered by lastUpdateTime (or endTime) ascending"
  -- ordering is a plain indexed sort.
  order_time              TIMESTAMPTZ NOT NULL,

  -- State & classification
  call_state              TEXT        NOT NULL,    -- ongoing | ended | missed | abandoned
  call_direction          TEXT,                    -- inbound | outbound | internal | unknown
  call_type               TEXT,                    -- peer_to_peer | conference | ...
  media_type              TEXT        NOT NULL,    -- voice | video | chat | instant_message | email | unknown

  -- Denormalised for filtering
  groups                  TEXT[]      NOT NULL DEFAULT '{}',
  recording_status        TEXT,                    -- recorded | not_recorded | partial | unknown

  -- Full spec-compliant CallRecord
  record                  JSONB       NOT NULL,

  received_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
