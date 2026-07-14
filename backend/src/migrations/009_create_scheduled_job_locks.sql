-- ─────────────────────────────────────────────────────────────────────────────
-- scheduled_job_locks
--
-- Lease-based claim table so this platform's periodic jobs (audit-log prune,
-- remote_source_rejects prune, remote-source polling) run at most once at a
-- time across N backend replicas, not once per replica. One row per distinct
-- job name (job_name is e.g. "audit_log_prune", or "remote_source_poll:<id>"
-- for per-source polling) — created on first claim, reused thereafter.
-- See db/jobLock.ts's tryClaimJob() for the claim query itself.
--
-- Deliberately not a Postgres advisory lock: those are scoped to a session
-- or transaction, pinning a pool connection for the claim's whole duration —
-- fine for a fast prune DELETE, but remote-source polling can legitimately
-- run for minutes. A claim row is a single fast upsert, connection returned
-- to the pool immediately, and self-heals if a replica dies mid-job (the
-- lease just expires — no dependency on Postgres noticing a dead session).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduled_job_locks (
  job_name      TEXT        PRIMARY KEY,
  locked_until  TIMESTAMPTZ NOT NULL
);
