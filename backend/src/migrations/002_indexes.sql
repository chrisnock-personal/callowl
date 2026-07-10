-- ─────────────────────────────────────────────────────────────────────────────
-- Constraints & indexes
--
-- callId is the stable, non-recycled identifier from the switch (spec: "must be
-- stable and not recycled"). We upsert on it, so it is UNIQUE.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_records_call_id
  ON call_records (call_id);

-- Primary query path: GET /calls filters on the time window and orders by
-- order_time ascending. A single index serves both.
CREATE INDEX IF NOT EXISTS ix_call_records_order_time
  ON call_records (order_time);

-- Media type filter (comma-delimited list → = ANY).
CREATE INDEX IF NOT EXISTS ix_call_records_media_type
  ON call_records (media_type);

-- Tenant scoping (X-Tenant-Id header).
CREATE INDEX IF NOT EXISTS ix_call_records_tenant
  ON call_records (tenant_id);

-- Group include / exclude filtering uses array overlap (&&).
CREATE INDEX IF NOT EXISTS ix_call_records_groups
  ON call_records USING GIN (groups);

-- Ad-hoc queries into the full record (e.g. statistics by callSource).
CREATE INDEX IF NOT EXISTS ix_call_records_record
  ON call_records USING GIN (record);

-- Chain reconstruction: parent / related legs for transfers & conferences.
CREATE INDEX IF NOT EXISTS ix_call_records_parent
  ON call_records (parent_call_id)
  WHERE parent_call_id IS NOT NULL;
