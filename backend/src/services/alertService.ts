import { query } from "../db/pool";
import { config } from "../config";
import { logger } from "../logger";
import { getLastAttempt, getOffsiteLastAttempt, listBackups } from "../db/backup";
import { getArchiverStatus, getBaseBackupLastAttempt } from "../db/pitr";
import { listRemoteSources } from "./remoteSourceService";

export interface Condition {
  key: string;
  healthy: boolean;
  message: string;
}

// Same staleness thresholds the dashboard's Backups panel already computes
// client-side (frontend/src/App.tsx) — duplicated here rather than shared,
// since an alert has to fire whether or not a browser is open to compute it.
async function evaluateConditions(): Promise<Condition[]> {
  const conditions: Condition[] = [];

  if (config.backups.dir) {
    const last = getLastAttempt();
    const latest = listBackups()[0];
    const stale =
      last?.status === "failed" ||
      (!!latest &&
        Date.now() - new Date(latest.createdAt).getTime() > 2 * config.backups.intervalHours * 3_600_000);
    conditions.push({
      key: "backup_pg_dump",
      healthy: !stale,
      message:
        last?.status === "failed"
          ? `Last scheduled pg_dump backup (${last.at}) failed`
          : stale
            ? `No successful pg_dump backup in over ${2 * config.backups.intervalHours}h`
            : "pg_dump backups healthy",
    });
  }

  const archiving = await getArchiverStatus();
  if (archiving) {
    const ARCHIVE_STALE_MS = 10 * 60 * 1000;
    const stale =
      !!archiving.lastArchivedAt &&
      Date.now() - new Date(archiving.lastArchivedAt).getTime() > ARCHIVE_STALE_MS;
    conditions.push({
      key: "pitr_archiving",
      healthy: !stale,
      message: stale ? "No WAL archived in over 10 minutes" : "WAL archiving healthy",
    });
  }

  const lastBase = getBaseBackupLastAttempt();
  if (lastBase) {
    const stale =
      lastBase.status === "failed" ||
      Date.now() - new Date(lastBase.at).getTime() > 2 * config.pitr.baseBackupIntervalHours * 3_600_000;
    conditions.push({
      key: "pitr_base_backup",
      healthy: !stale,
      message:
        lastBase.status === "failed"
          ? `Last PITR base backup (${lastBase.at}) failed`
          : stale
            ? `No successful PITR base backup in over ${2 * config.pitr.baseBackupIntervalHours}h`
            : "PITR base backups healthy",
    });
  }

  if (config.offsite.endpoint) {
    const last = getOffsiteLastAttempt();
    if (last) {
      const stale =
        last.status === "failed" ||
        Date.now() - new Date(last.at).getTime() > 2 * config.offsite.intervalHours * 3_600_000;
      conditions.push({
        key: "offsite_sync",
        healthy: !stale,
        message:
          last.status === "failed"
            ? `Last off-host backup sync (${last.at}) failed`
            : stale
              ? `No successful off-host backup sync in over ${2 * config.offsite.intervalHours}h`
              : "Off-host backup sync healthy",
      });
    }
  }

  const sources = await listRemoteSources();
  for (const s of sources) {
    if (!s.enabled) continue;
    const failed = s.lastPollStatus === "auth_error" || s.lastPollStatus === "fetch_error";
    conditions.push({
      key: `remote_source_poll:${s.id}`,
      healthy: !failed,
      message: failed
        ? `Remote source "${s.name}" last poll failed (${s.lastPollStatus}): ${s.lastPollError ?? "no detail"}`
        : `Remote source "${s.name}" polling healthy`,
    });
  }

  return conditions;
}

async function sendWebhook(condition: Condition, kind: "alert" | "recovered"): Promise<void> {
  const url = config.alerts.webhookUrl;
  if (!url) return;
  const text =
    kind === "recovered"
      ? `✅ CallOwl: "${condition.key}" recovered — ${condition.message}`
      : `🚨 CallOwl: "${condition.key}" unhealthy — ${condition.message}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        condition: condition.key,
        status: kind === "recovered" ? "recovered" : "unhealthy",
        message: condition.message,
        occurredAt: new Date().toISOString(),
        // Redundant with the fields above for a generic webhook receiver,
        // but it's what Slack/Discord incoming webhooks actually render —
        // including it means one ALERT_WEBHOOK_URL works for either without
        // any Slack-specific code path.
        text,
      }),
    });
    if (!res.ok) {
      logger.error("Alert webhook returned non-2xx", { condition: condition.key, status: res.status });
    }
  } catch (err) {
    logger.error("Alert webhook request failed", { condition: condition.key, err });
  }
}

interface AlertStateRow {
  condition: string;
  healthy: boolean;
  last_alert_at: string | null;
}

/**
 * Evaluates every condition, notifies on a healthy<->unhealthy transition or
 * (for a condition that's stayed unhealthy) once ALERT_COOLDOWN_HOURS has
 * passed since the last notification, and persists the new state either way
 * — called on a schedule from index.ts, behind tryClaimJob like the other
 * scheduled jobs there. One SELECT (WHERE condition = ANY(...)) and one
 * multi-row upsert for however many conditions exist, rather than a pair of
 * round trips per condition — this runs on every tick for the life of the
 * process, so the query count doesn't scale with the number of remote
 * sources configured. Only the webhook POST itself stays per-condition,
 * since each one's send/skip decision is independent and the requests can't
 * usefully be batched.
 */
export async function checkAndNotify(): Promise<void> {
  const conditions = await evaluateConditions();
  if (conditions.length === 0) return;
  const now = new Date();

  const priorRows = await query<AlertStateRow>(
    "SELECT condition, healthy, last_alert_at FROM alert_state WHERE condition = ANY($1)",
    [conditions.map((c) => c.key)]
  );
  const priorByKey = new Map(priorRows.map((r) => [r.condition, r]));

  const upsertParams: unknown[] = [];
  const upsertValues: string[] = [];

  for (const c of conditions) {
    const prev = priorByKey.get(c.key);

    let shouldNotify = false;
    let kind: "alert" | "recovered" = "alert";

    if (!c.healthy) {
      if (!prev || prev.healthy) {
        shouldNotify = true;
      } else if (
        prev.last_alert_at &&
        now.getTime() - new Date(prev.last_alert_at).getTime() > config.alerts.cooldownHours * 3_600_000
      ) {
        shouldNotify = true;
      }
    } else if (prev && !prev.healthy) {
      shouldNotify = true;
      kind = "recovered";
    }

    if (shouldNotify) {
      await sendWebhook(c, kind);
    }

    const base = upsertParams.length;
    upsertValues.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, now())`);
    upsertParams.push(
      c.key,
      c.healthy,
      c.message,
      shouldNotify ? now.toISOString() : (prev?.last_alert_at ?? null)
    );
  }

  await query(
    `INSERT INTO alert_state (condition, healthy, message, last_alert_at, updated_at)
     VALUES ${upsertValues.join(", ")}
     ON CONFLICT (condition) DO UPDATE
       SET healthy = EXCLUDED.healthy, message = EXCLUDED.message,
           last_alert_at = EXCLUDED.last_alert_at, updated_at = now()`,
    upsertParams
  );
}
