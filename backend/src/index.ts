import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { config } from "./config";
import { testConnection, closePool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { seedExamples } from "./db/seed";
import { seedAdmin } from "./db/seedAdmin";
import { pruneAuditLog } from "./services/auditService";
import { auditLog } from "./middleware/audit";
import { errorHandler, notFound } from "./middleware/errorHandler";
import { openApiSpec } from "./openapi";
import callsRouter from "./routes/calls";
import statisticsRouter from "./routes/statistics";
import healthRouter from "./routes/health";
import adminRouter from "./routes/admin";
import authRouter from "./routes/auth";

const app = express();
const BASE = config.apiBasePath;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "8mb" })); // batches of CDRs can be large
app.use(cookieParser());
app.use(auditLog);

if (config.nodeEnv === "development") {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

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

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use(`${BASE}/health`, healthRouter);
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
    customSiteTitle: "Open CDR Platform — API Docs",
    swaggerOptions: { docExpansion: "list", filter: true, tagsSorter: "alpha" },
  })
);

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
    // need pg_dump, which isn't in this image).
    await pruneAuditLog(config.auditLog.retentionDays);
    setInterval(() => {
      pruneAuditLog(config.auditLog.retentionDays).catch((err) =>
        console.error("Audit log prune failed:", err)
      );
    }, 24 * 60 * 60 * 1000);

    const server = app.listen(config.port, () => {
      console.log(
        `🚀  Open CDR Platform API on port ${config.port} [${config.nodeEnv}]`
      );
      console.log(`    Health:   http://localhost:${config.port}${BASE}/health`);
      console.log(`    Calls:    http://localhost:${config.port}${BASE}/calls`);
      console.log(`    Stats:    http://localhost:${config.port}${BASE}/statistics/summary`);
      console.log(`    Ingest:   POST http://localhost:${config.port}${BASE}/calls/ingest`);
      console.log(`    Docs:     http://localhost:${config.port}${BASE}/docs`);
    });

    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received — shutting down...`);
      server.close(async () => {
        await closePool();
        console.log("✅  Shutdown complete");
        process.exit(0);
      });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    console.error("❌  Failed to start:", err);
    process.exit(1);
  }
}

start();
