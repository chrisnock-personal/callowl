-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log
--
-- One row per HTTP request that reaches a route with compliance value —
-- written by a single global middleware (middleware/audit.ts), not scattered
-- calls in each handler, so coverage can't silently miss a new endpoint later.
--
-- actor_type/actor_id: 'user' (session cookie or a per-user API key — both
-- resolve to req.user, so both attribute to the same username), 'ingest_key'
-- or 'admin_key' (the shared INGEST_API_KEY/ADMIN_API_KEY secrets — not
-- attributable to a person), or 'anonymous' (no valid credential at all —
-- this is what a failed login attempt or a bare 401 looks like here).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type   TEXT        NOT NULL,
  actor_id     TEXT,
  method       TEXT        NOT NULL,
  path         TEXT        NOT NULL,
  status_code  INT         NOT NULL,
  record_count INT,
  params       JSONB,
  ip_address   TEXT
);

CREATE INDEX IF NOT EXISTS ix_audit_log_occurred_at ON audit_log (occurred_at);
CREATE INDEX IF NOT EXISTS ix_audit_log_actor ON audit_log (actor_id);
