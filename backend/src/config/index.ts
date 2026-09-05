import dotenv from "dotenv";
import path from "path";
import { z } from "zod";
import { logger } from "../logger";

dotenv.config();

const envSchema = z.object({
  // Server
  PORT: z.string().default("3001"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // PostgreSQL connection
  PGHOST: z.string().min(1, "PGHOST is required"),
  PGPORT: z.string().default("5432"),
  PGDATABASE: z.string().min(1, "PGDATABASE is required"),
  PGUSER: z.string().min(1, "PGUSER is required"),
  PGPASSWORD: z.string().min(1, "PGPASSWORD is required"),
  PGSSL: z.enum(["true", "false"]).default("false"),

  // Optional connection pool tuning
  PG_POOL_MAX: z.string().default("10"),
  PG_POOL_IDLE_TIMEOUT_MS: z.string().default("30000"),
  PG_POOL_CONNECTION_TIMEOUT_MS: z.string().default("5000"),

  // CORS
  CORS_ORIGIN: z.string().default("*"),

  // Ingest auth — if set, POST /calls/ingest requires this key via X-API-Key.
  // Left unset in dev/local mode so ingestion works without a key. Accepts a
  // comma-separated list (e.g. "new,old") so a key can be rotated without a
  // flag-day cutover — see SECRETS_ROTATION.md.
  INGEST_API_KEY: z.string().optional(),

  // Admin auth — if set, triggering a backup, downloading one, or restoring
  // requires this key via X-API-Key. The read-only backup list does not.
  // Left unset in dev/local mode. Strongly recommended once exposed beyond a
  // local lab: restore replaces the database outright. Comma-separated list,
  // same rotation support as INGEST_API_KEY.
  ADMIN_API_KEY: z.string().optional(),

  // Seed the five example scenarios from the Open CDR Standard on first boot.
  SEED_EXAMPLES: z.enum(["true", "false"]).default("true"),

  // Where the `backup` compose service writes pg_dump files, and where the
  // backend's own on-demand backup/restore endpoints read and write.
  BACKUPS_DIR: z.string().optional(),
  BACKUP_RETENTION_DAYS: z.string().default("14"),
  BACKUP_INTERVAL_HOURS: z.string().default("24"),

  // How often the db service's pgBackRest loop takes a new PITR base
  // backup — same var already passed to `db` in docker-compose.yml; needed
  // here too so GET /admin/backups can compute staleness for the base-backup
  // half of PITR health, the same way BACKUP_INTERVAL_HOURS does for pg_dump.
  PITR_BACKUP_INTERVAL_HOURS: z.string().default("24"),

  // Off-host copy of both backup artifacts (pg_dump + PITR repo) to a
  // separate S3-compatible target — see the `offsite-backup` compose service
  // and scripts/offsite-sync.sh, which actually own the sync credentials
  // (OFFSITE_S3_ACCESS_KEY/SECRET_KEY/BUCKET). The backend only needs the
  // endpoint (to know whether it's configured at all) and the interval (to
  // compute staleness for the dashboard), the same "configured?" + interval
  // shape BACKUPS_DIR/BACKUP_INTERVAL_HOURS already have.
  OFFSITE_S3_ENDPOINT: z.string().optional(),
  OFFSITE_SYNC_INTERVAL_HOURS: z.string().default("24"),

  // Shared with the `frontend` container's /etc/nginx/certs (same `certs`
  // volume, different mount point — see db/tlsCert.ts and
  // frontend/cert-watcher.sh) so GET/POST /admin/tls can read/replace the
  // TLS certificate nginx serves.
  TLS_CERTS_DIR: z.string().optional(),

  // Outbound alerting (services/alertService.ts) — posts JSON (with a `text`
  // field Slack/Discord incoming webhooks render directly, so one URL works
  // for either without Slack-specific code) to this URL on a health-signal
  // transition, or after ALERT_COOLDOWN_HOURS if a condition stays unhealthy.
  // Left unset, the scheduled check still runs (cheap — reuses the same
  // status reads GET /admin/backups already does) but never actually posts.
  ALERT_WEBHOOK_URL: z.string().optional(),
  ALERT_COOLDOWN_HOURS: z.string().default("6"),
  ALERT_CHECK_INTERVAL_MINUTES: z.string().default("5"),

  // Dashboard/API user accounts. The bootstrap admin is created on first boot
  // if the users table is empty — see db/seedAdmin.ts. Login is required for
  // every user beyond that; there's no "open" mode once this exists.
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),

  // Code-level default stays non-Secure so the bare `npm run dev` workflow
  // (genuinely plain HTTP, no committed backend/.env to override this) never
  // silently breaks login. docker-compose.yml/.env.example default this to
  // "true" instead, since the frontend nginx container terminates HTTPS by
  // default there (self-signed out of the box — see
  // frontend/docker-entrypoint.sh) and plain HTTP redirects to it rather
  // than serving the app directly.
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),

  // How long audit_log entries are kept — pruned once on boot and daily
  // thereafter (see index.ts). Mirrors BACKUP_RETENTION_DAYS.
  AUDIT_LOG_RETENTION_DAYS: z.string().default("90"),

  // Reversible-encryption key (32 bytes, base64 — openssl rand -base64 32)
  // for remote source credentials (services/cryptoService.ts). Optional at
  // boot, same as ADMIN_API_KEY/BACKUPS_DIR — this feature is fully opt-in,
  // so deployments that never configure a remote source don't need it.
  // Gated at the point of use: creating a remote source with a secret while
  // this is unset returns a 501, same pattern as the backups endpoints do
  // for an unconfigured BACKUPS_DIR.
  REMOTE_SOURCE_ENC_KEY: z.string().optional(),

  // During a rotation window (see SECRETS_ROTATION.md): decrypt falls back to
  // this key if REMOTE_SOURCE_ENC_KEY fails, so already-stored credentials
  // keep working while new writes move onto the new key. Unset once
  // `npm run rotate-encryption-keys` has migrated every row.
  REMOTE_SOURCE_ENC_KEY_PREVIOUS: z.string().optional(),

  // How long remote_source_rejects entries are kept — pruned once on boot
  // and daily thereafter (see index.ts). Mirrors AUDIT_LOG_RETENTION_DAYS.
  REMOTE_SOURCE_REJECTS_RETENTION_DAYS: z.string().default("90"),

  // Per-account login lockout (services/authService.ts), independent of the
  // per-IP loginRateLimit (index.ts) — closes the "slow, patient attempt
  // spread across many source IPs" gap that IP-based rate limiting alone
  // can't. LOGIN_LOCKOUT_DURATION_MINUTES mirrors loginRateLimit's own
  // 15-minute window for consistency.
  LOGIN_LOCKOUT_THRESHOLD: z.string().default("5"),
  LOGIN_LOCKOUT_DURATION_MINUTES: z.string().default("15"),
  // How long a login_lockouts row lingers after its last attempt before
  // being pruned (see index.ts) — every distinct username ever submitted to
  // POST /auth/login gets a row here by design (real or fake, to avoid a
  // username-existence oracle — see the lockout comment below), so unlike
  // audit_log this has no record-keeping value past the lockout window
  // itself; short by default on purpose.
  LOGIN_LOCKOUT_ROW_RETENTION_DAYS: z.string().default("7"),

  // Reversible-encryption key for TOTP MFA secrets (services/mfaService.ts,
  // via cryptoService.ts) — has to be read back to verify codes, unlike a
  // password hash. Deliberately separate from REMOTE_SOURCE_ENC_KEY: a
  // deployment that only wants MFA shouldn't need a key named for an
  // unrelated feature, and rotating one shouldn't force re-enrolling the
  // other. Optional at boot, same posture as REMOTE_SOURCE_ENC_KEY — gated
  // at the point of use (enrolling MFA while this is unset returns a 501).
  MFA_ENC_KEY: z.string().optional(),

  // Same rotation-window fallback as REMOTE_SOURCE_ENC_KEY_PREVIOUS, for MFA secrets.
  MFA_ENC_KEY_PREVIOUS: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  logger.error("Invalid environment configuration", {
    issues: parsed.error.errors.map((err) => ({ path: err.path.join("."), message: err.message })),
  });
  process.exit(1);
}

const env = parsed.data;

// Spec artifacts are copied into src/data and compiled path differs between
// ts-node (src) and built output (dist). Resolve relative to this file.
const dataDir = path.join(__dirname, "..", "data");

// "new,old" -> ["new", "old"]; unset/empty -> [] (same "unauthenticated" meaning
// an empty/falsy single value had before). A lone value still works identically.
function parseKeyList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export const config = {
  port: parseInt(env.PORT, 10),
  nodeEnv: env.NODE_ENV,
  corsOrigin: env.CORS_ORIGIN,
  ingestApiKeys: parseKeyList(env.INGEST_API_KEY),
  adminApiKeys: parseKeyList(env.ADMIN_API_KEY),
  seedExamples: env.SEED_EXAMPLES === "true",

  apiBasePath: "/api/cdr/v1",
  apiVersion: "1.0.0",
  platformVersion: "CallOwl 0.2.0",

  paths: {
    schemaYaml: path.join(dataDir, "cdr-schema.yaml"),
    examplesJson: path.join(dataDir, "cdr-examples.json"),
  },

  backups: {
    dir: env.BACKUPS_DIR,
    retentionDays: parseInt(env.BACKUP_RETENTION_DAYS, 10),
    intervalHours: parseInt(env.BACKUP_INTERVAL_HOURS, 10),
  },

  pitr: {
    baseBackupIntervalHours: parseInt(env.PITR_BACKUP_INTERVAL_HOURS, 10),
  },

  offsite: {
    endpoint: env.OFFSITE_S3_ENDPOINT,
    intervalHours: parseInt(env.OFFSITE_SYNC_INTERVAL_HOURS, 10),
  },

  tls: {
    certsDir: env.TLS_CERTS_DIR,
  },

  alerts: {
    webhookUrl: env.ALERT_WEBHOOK_URL,
    cooldownHours: parseInt(env.ALERT_COOLDOWN_HOURS, 10),
    checkIntervalMinutes: parseInt(env.ALERT_CHECK_INTERVAL_MINUTES, 10),
  },

  auth: {
    bootstrapAdminUsername: env.BOOTSTRAP_ADMIN_USERNAME,
    bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD,
    cookieSecure: env.COOKIE_SECURE === "true",
  },

  auditLog: {
    retentionDays: parseInt(env.AUDIT_LOG_RETENTION_DAYS, 10),
  },

  remoteSources: {
    encryptionKey: env.REMOTE_SOURCE_ENC_KEY,
    encryptionKeyPrevious: env.REMOTE_SOURCE_ENC_KEY_PREVIOUS,
    rejectsRetentionDays: parseInt(env.REMOTE_SOURCE_REJECTS_RETENTION_DAYS, 10),
  },

  loginLockout: {
    threshold: parseInt(env.LOGIN_LOCKOUT_THRESHOLD, 10),
    durationMinutes: parseInt(env.LOGIN_LOCKOUT_DURATION_MINUTES, 10),
    rowRetentionDays: parseInt(env.LOGIN_LOCKOUT_ROW_RETENTION_DAYS, 10),
  },

  mfa: {
    encryptionKey: env.MFA_ENC_KEY,
    encryptionKeyPrevious: env.MFA_ENC_KEY_PREVIOUS,
  },

  db: {
    host: env.PGHOST,
    port: parseInt(env.PGPORT, 10),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
    max: parseInt(env.PG_POOL_MAX, 10),
    idleTimeoutMillis: parseInt(env.PG_POOL_IDLE_TIMEOUT_MS, 10),
    connectionTimeoutMillis: parseInt(env.PG_POOL_CONNECTION_TIMEOUT_MS, 10),
  },
} as const;
