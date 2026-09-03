-- ─────────────────────────────────────────────────────────────────────────────
-- Outbound alerting on existing health signals (services/alertService.ts) —
-- backup/PITR/off-host-sync staleness and remote-source poll failures are
-- already computed for the dashboard's warning states; this is what lets a
-- scheduled job (backend/src/index.ts) push the same conditions to
-- ALERT_WEBHOOK_URL instead of only rendering them.
--
-- One row per condition (a fixed key like "backup_pg_dump", or
-- "remote_source_poll:<id>" for a per-source one) tracking current health —
-- condition is the primary key rather than an auto-increment id, since
-- there's exactly one current-state row per condition to upsert, never a
-- history of them (the audit log already covers "what happened when" for
-- anything that needs it). last_alert_at drives both edge-triggered
-- notifications (a transition healthy<->unhealthy always notifies) and
-- ALERT_COOLDOWN_HOURS re-notification for a condition that's stayed
-- unhealthy, so a long incident doesn't go silent after the first alert
-- without notifying on every single check tick either.
CREATE TABLE alert_state (
  condition      text PRIMARY KEY,
  healthy        boolean NOT NULL,
  message        text NOT NULL,
  last_alert_at  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
