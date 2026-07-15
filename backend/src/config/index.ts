import dotenv from "dotenv";
import path from "path";
import { z } from "zod";

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
  // Left unset in dev/local mode so ingestion works without a key.
  INGEST_API_KEY: z.string().optional(),

  // Admin auth — if set, triggering a backup, downloading one, or restoring
  // requires this key via X-API-Key. The read-only backup list does not.
  // Left unset in dev/local mode. Strongly recommended once exposed beyond a
  // local lab: restore replaces the database outright.
  ADMIN_API_KEY: z.string().optional(),

  // Seed the five example scenarios from the Open CDR Standard on first boot.
  SEED_EXAMPLES: z.enum(["true", "false"]).default("true"),

  // Where the `backup` compose service writes pg_dump files, and where the
  // backend's own on-demand backup/restore endpoints read and write.
  BACKUPS_DIR: z.string().optional(),
  BACKUP_RETENTION_DAYS: z.string().default("14"),
  BACKUP_INTERVAL_HOURS: z.string().default("24"),

  // Dashboard/API user accounts. The bootstrap admin is created on first boot
  // if the users table is empty — see db/seedAdmin.ts. Login is required for
  // every user beyond that; there's no "open" mode once this exists.
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),

  // Session cookies default to non-Secure since the stack runs over plain
  // HTTP by default (no TLS — see README Status). Set true only once this is
  // actually served over HTTPS (e.g. behind a TLS-terminating reverse proxy),
  // otherwise browsers silently refuse to send the cookie and login breaks.
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

  // Reversible-encryption key for TOTP MFA secrets (services/mfaService.ts,
  // via cryptoService.ts) — has to be read back to verify codes, unlike a
  // password hash. Deliberately separate from REMOTE_SOURCE_ENC_KEY: a
  // deployment that only wants MFA shouldn't need a key named for an
  // unrelated feature, and rotating one shouldn't force re-enrolling the
  // other. Optional at boot, same posture as REMOTE_SOURCE_ENC_KEY — gated
  // at the point of use (enrolling MFA while this is unset returns a 501).
  MFA_ENC_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌  Invalid environment configuration:");
  parsed.error.errors.forEach((err) => {
    console.error(`    ${err.path.join(".")}: ${err.message}`);
  });
  process.exit(1);
}

const env = parsed.data;

// Spec artifacts are copied into src/data and compiled path differs between
// ts-node (src) and built output (dist). Resolve relative to this file.
const dataDir = path.join(__dirname, "..", "data");

export const config = {
  port: parseInt(env.PORT, 10),
  nodeEnv: env.NODE_ENV,
  corsOrigin: env.CORS_ORIGIN,
  ingestApiKey: env.INGEST_API_KEY,
  adminApiKey: env.ADMIN_API_KEY,
  seedExamples: env.SEED_EXAMPLES === "true",

  apiBasePath: "/api/cdr/v1",
  apiVersion: "1.0.0",
  platformVersion: "OpenCDR Platform 0.1.0",

  paths: {
    schemaYaml: path.join(dataDir, "cdr-schema.yaml"),
    examplesJson: path.join(dataDir, "cdr-examples.json"),
  },

  backups: {
    dir: env.BACKUPS_DIR,
    retentionDays: parseInt(env.BACKUP_RETENTION_DAYS, 10),
    intervalHours: parseInt(env.BACKUP_INTERVAL_HOURS, 10),
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
    rejectsRetentionDays: parseInt(env.REMOTE_SOURCE_REJECTS_RETENTION_DAYS, 10),
  },

  loginLockout: {
    threshold: parseInt(env.LOGIN_LOCKOUT_THRESHOLD, 10),
    durationMinutes: parseInt(env.LOGIN_LOCKOUT_DURATION_MINUTES, 10),
  },

  mfa: {
    encryptionKey: env.MFA_ENC_KEY,
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
