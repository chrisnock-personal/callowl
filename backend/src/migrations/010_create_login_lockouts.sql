-- ─────────────────────────────────────────────────────────────────────────────
-- login_lockouts
--
-- Per-account lockout on top of the existing per-IP rate limiter
-- (loginRateLimit, index.ts) — that alone doesn't stop a slow, patient
-- attempt spread across many source IPs. Keyed by the *submitted username
-- string*, not a resolved user id, deliberately including usernames that
-- don't exist: if only real accounts could lock, an attacker could tell
-- "this username exists" (locks after N tries) apart from "it doesn't"
-- (never locks) — turning a hardening feature into a username oracle.
-- See services/authService.ts's checkLockout/recordFailedLogin/recordSuccessfulLogin.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS login_lockouts (
  username        TEXT        PRIMARY KEY,
  failed_count    INT         NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
