import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { config } from "./config";
import { logger } from "./logger";
import { testConnection, closePool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { tryClaimJob } from "./db/jobLock";
import { seedExamples } from "./db/seed";
import { seedAdmin } from "./db/seedAdmin";
import { pruneAuditLog } from "./services/auditService";
import { auditLog } from "./middleware/audit";
import { metrics } from "./middleware/metrics";
import { errorHandler, notFound } from "./middleware/errorHandler";
import { openApiSpec } from "./openapi";
import callsRouter from "./routes/calls";
import statisticsRouter from "./routes/statistics";
import healthRouter from "./routes/health";
import metricsRouter from "./routes/metrics";
import adminRouter from "./routes/admin";
import authRouter from "./routes/auth";
import { listRemoteSources, pruneRemoteSourceRejects, type RemoteSourceMeta } from "./services/remoteSourceService";
import { pollRemoteSource } from "./services/remotePollService";

const app = express();
const BASE = config.apiBasePath;

// Requests only ever reach this process through one reverse proxy hop — the
// frontend nginx container's proxy_pass (see frontend/nginx.conf), and in a
// public deployment a TLS-terminating proxy in front of that. Without this,
// req.ip (what the audit log records per request, and what the rate limiters
// below key on) resolves to the proxy's address for every request instead of
// the real client's. Bump the number if another hop (e.g. a CDN) is added.
app.set("trust proxy", 1);

// ─── Middleware ───────────────────────────────────────────────────────────────
// CSP is left off: swagger-ui-express's bundled UI relies on inline scripts,
// and a hand-tuned CSP just for /docs isn't worth it for an API-only backend
// that doesn't render user-controlled HTML anywhere. The rest of helmet's
// defaults (HSTS, X-Content-Type-Options, X-Frame-Options, hiding
// X-Powered-By, etc.) still apply.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "8mb" })); // batches of CDRs can be large
app.use(cookieParser());
app.use(auditLog);
app.use(metrics);

// Ingest can be high-volume — cap per-IP but generously.
const ingestRateLimit = rateLimit({
  windowMs: 60_000,
  max: 5_000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "rate_limited",
      message: "Ingest rate limit exceeded — batch records or slow down",
    },
  },
});

// Unlike ingest, login has no legitimate high-volume use — keep this tight
// enough to blunt brute-force/credential-stuffing attempts once this is
// reachable from the public internet, generous enough that a real user
// mistyping a password a few times never sees it.
const loginRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "rate_limited",
      message: "Too many login attempts — try again later",
    },
  },
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use(`${BASE}/health`, healthRouter);
app.use(`${BASE}/metrics`, metricsRouter);
app.use(`${BASE}/auth/login`, loginRateLimit);
app.use(`${BASE}/auth`, authRouter);
app.use(`${BASE}/statistics`, statisticsRouter);
app.use(`${BASE}/admin`, adminRouter);
// Rate-limit only the ingest sub-path, then mount the full calls router.
app.use(`${BASE}/calls/ingest`, ingestRateLimit);
app.use(`${BASE}/calls`, callsRouter);

// ─── OpenAPI spec + Swagger UI ────────────────────────────────────────────────
app.get(`${BASE}/openapi.json`, (_req, res) => res.json(openApiSpec));
app.use(
  `${BASE}/docs`,
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customSiteTitle: "CallOwl — API Docs",
    swaggerOptions: { docExpansion: "list", filter: true, tagsSorter: "alpha" },
  })
);

// ─── Remote source polling ──────────────────────────────────────────────────
// In-process setInterval, same choice as pruneAuditLog above — polling a
// remote HTTP API needs no special binary, unlike the `backup` compose
// service, which exists solely because it needs pg_dump/pg_restore. Ticks
// every 60s and skips sources not yet due, rather than one setInterval per
// source, since poll_interval_minutes is per-source and this is simpler than
// managing N independent timers.
function isRemoteSourceDue(source: RemoteSourceMeta, now: Date): boolean {
  if (!source.lastPolledAt) return true;
  const dueAt = new Date(source.lastPolledAt).getTime() + source.pollIntervalMinutes * 60_000;
  return now.getTime() >= dueAt;
}

async function pollDueRemoteSources(): Promise<void> {
  const sources = await listRemoteSources();
  const due = sources.filter((s) => s.enabled && isRemoteSourceDue(s, new Date()));
  // Sequential, not Promise.all — avoids N sources hammering the DB pool or
  // making concurrent outbound calls at once from this one process.
  for (const s of due) {
    try {
      await pollRemoteSource(s.id);
    } catch (err) {
      logger.error("Remote source poll failed", { sourceId: s.id, err });
    }
  }
}

// ─── 404 & error handlers ─────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  try {
    await testConnection();
    await runMigrations();
    if (config.seedExamples) await seedExamples();
    await seedAdmin();

    // Prune once on boot, then daily — a plain SQL delete, so no separate
    // sidecar service is needed the way scheduled backups need one (those
    // need pg_dump, which isn't in this image). tryClaimJob (db/jobLock.ts)
    // makes this safe across N replicas: only whichever replica wins the
    // claim actually runs the prune, others skip this tick. A 5-minute lease
    // comfortably covers a real prune while still handing off quickly if the
    // claiming replica dies mid-run.
    const AUDIT_LOG_PRUNE_LEASE_MS = 5 * 60_000;
    const REMOTE_REJECTS_PRUNE_LEASE_MS = 5 * 60_000;

    if (await tryClaimJob("audit_log_prune", AUDIT_LOG_PRUNE_LEASE_MS)) {
      await pruneAuditLog(config.auditLog.retentionDays);
    }
    setInterval(() => {
      (async () => {
        if (await tryClaimJob("audit_log_prune", AUDIT_LOG_PRUNE_LEASE_MS)) {
          await pruneAuditLog(config.auditLog.retentionDays);
        }
      })().catch((err) => logger.error("Audit log prune failed", { err }));
    }, 24 * 60 * 60 * 1000);

    if (await tryClaimJob("remote_source_rejects_prune", REMOTE_REJECTS_PRUNE_LEASE_MS)) {
      await pruneRemoteSourceRejects(config.remoteSources.rejectsRetentionDays);
    }
    setInterval(() => {
      (async () => {
        if (
          await tryClaimJob("remote_source_rejects_prune", REMOTE_REJECTS_PRUNE_LEASE_MS)
        ) {
          await pruneRemoteSourceRejects(config.remoteSources.rejectsRetentionDays);
        }
      })().catch((err) => logger.error("Remote source rejects prune failed", { err }));
    }, 24 * 60 * 60 * 1000);

    // Not called synchronously here before app.listen the way the prunes
    // above are — a slow/hanging remote fetch on boot shouldn't block
    // startup. The first 60s tick after boot handles it instead.
    setInterval(() => {
      pollDueRemoteSources().catch((err) => logger.error("Remote source poll cycle failed", { err }));
    }, 60_000);

    const server = app.listen(config.port, () => {
      logger.info("Open CDR Platform API started", {
        port: config.port,
        env: config.nodeEnv,
        health: `http://localhost:${config.port}${BASE}/health`,
        calls: `http://localhost:${config.port}${BASE}/calls`,
        stats: `http://localhost:${config.port}${BASE}/statistics/summary`,
        ingest: `POST http://localhost:${config.port}${BASE}/calls/ingest`,
        docs: `http://localhost:${config.port}${BASE}/docs`,
      });
    });

    const shutdown = async (signal: string) => {
      logger.info("Shutting down", { signal });
      server.close(async () => {
        await closePool();
        logger.info("Shutdown complete");
        process.exit(0);
      });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    logger.error("Failed to start", { err });
    process.exit(1);
  }
}

start();
