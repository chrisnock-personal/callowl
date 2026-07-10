-- ─────────────────────────────────────────────────────────────────────────────
-- users / sessions
--
-- Dashboard/API user accounts and their sessions. Separate from the existing
-- INGEST_API_KEY/ADMIN_API_KEY shared secrets, which stay as machine-auth for
-- the ingest endpoint and CLI/automation admin actions respectively — these
-- tables are for people logging into the dashboard.
--
-- allowed_groups / allowed_source_platform_ids: NULL means unrestricted (sees
-- everything); a non-NULL array constrains GET /calls and /statistics/* to
-- that set, intersected with whatever the request itself asks for.
--
-- sessions is a real server-side table (not a signed stateless token) so
-- logout and forced revocation are immediate — the whole point of choosing
-- cookie-sessions over JWTs here.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username                      TEXT        NOT NULL UNIQUE,
  password_hash                 TEXT        NOT NULL,
  role                          TEXT        NOT NULL DEFAULT 'viewer', -- 'admin' | 'viewer'
  allowed_groups                TEXT[],
  allowed_source_platform_ids   TEXT[],
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT        PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id);
