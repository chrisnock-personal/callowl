-- ─────────────────────────────────────────────────────────────────────────────
-- source_platform_id
--
-- Projects CallRecord.sourcePlatformId (added to the Open CDR Standard to let a
-- compliance platform ingesting from multiple switches disambiguate and
-- correlate records back to their source system). Not one of the standard's
-- documented GET /calls filters, so — like /calls/ingest — filtering on it is a
-- clearly-labelled platform extension rather than part of the standard's API.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE call_records ADD COLUMN IF NOT EXISTS source_platform_id TEXT;

CREATE INDEX IF NOT EXISTS ix_call_records_source_platform
  ON call_records (source_platform_id)
  WHERE source_platform_id IS NOT NULL;
