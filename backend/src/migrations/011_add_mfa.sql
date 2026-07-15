-- ─────────────────────────────────────────────────────────────────────────────
-- MFA (TOTP) — self-service opt-in second factor for dashboard login.
--
-- mfa_secret_encrypted is set as soon as enrollment begins (services/mfaService.ts's
-- beginEnrollment) but mfa_enabled stays false until the user proves they can
-- actually generate a valid code (confirmEnrollment) — an abandoned enrollment
-- never silently starts requiring a second factor. Encrypted via cryptoService.ts,
-- keyed by MFA_ENC_KEY — deliberately not REMOTE_SOURCE_ENC_KEY (see README):
-- a deployment that only wants MFA shouldn't need a key named for an unrelated
-- feature, and rotating one shouldn't force re-enrolling the other.
--
-- mfa_recovery_codes mirrors api_keys' hash-not-plaintext pattern — one-time
-- use (used_at set on redemption), shown to the user exactly once at
-- enrollment confirmation, same as an API key's raw value.
--
-- mfa_pending_logins mirrors sessions' "real server-side row, not a stateless
-- token" choice, for the same reason: a password-verified-but-not-yet-MFA'd
-- login needs to be revocable/expirable server-side. Short TTL (~5 minutes).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_encrypted TEXT;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_mfa_recovery_codes_user ON mfa_recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS mfa_pending_logins (
  token       TEXT        PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_mfa_pending_expires ON mfa_pending_logins (expires_at);
