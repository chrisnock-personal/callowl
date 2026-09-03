-- ─────────────────────────────────────────────────────────────────────────────
-- Public, unauthenticated status page (services/statusPageService.ts,
-- routes/status.ts) — off by default; an admin flips it on from the
-- dashboard's ⋯ menu, no redeploy needed, which is why this is a DB-backed
-- toggle rather than an env var like the rest of this platform's feature
-- flags. Single-row table (id always 1, seeded below) rather than a generic
-- key-value settings table, since there's exactly one setting to store today
-- and no evidence yet a second one is coming — not worth the extra
-- indirection until it is.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE status_page_config (
  id          int         PRIMARY KEY DEFAULT 1,
  enabled     boolean     NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO status_page_config (id, enabled) VALUES (1, false);
