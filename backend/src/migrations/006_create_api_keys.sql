-- ─────────────────────────────────────────────────────────────────────────────
-- api_keys
--
-- Per-user API keys — a named, revocable alternative to the session cookie for
-- programmatic access. A key acts as the user who created it: same role, same
-- allowed_groups/allowed_source_platform_ids, enforced by the same scopeFilters
-- path the session cookie already goes through. Deleting the user cascades to
-- their keys.
--
-- key_hash is sha256(raw key) — keys are high-entropy random tokens, not
-- user-chosen passwords, so a fast indexed hash is the right tool (no bcrypt
-- needed, same reasoning as sessions.id being an opaque token). The raw key
-- is only ever returned once, at creation time; key_prefix is stored in the
-- clear purely so the UI/logs can identify a key without the full secret.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  key_hash      TEXT        NOT NULL UNIQUE,
  key_prefix    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_api_keys_user ON api_keys (user_id);
