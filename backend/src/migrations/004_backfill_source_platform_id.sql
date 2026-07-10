-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill source_platform_id
--
-- 003 added the column after some records already carried sourcePlatformId in
-- their JSONB body. This syncs the projection to match what's already stored —
-- it does not add data to records that never had the field.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE call_records
   SET source_platform_id = record->>'sourcePlatformId'
 WHERE source_platform_id IS NULL
   AND record->>'sourcePlatformId' IS NOT NULL;
