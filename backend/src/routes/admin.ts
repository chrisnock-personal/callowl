import fs from "fs";
import path from "path";
import { Router, Request, Response, NextFunction } from "express";
import express from "express";
import { z } from "zod";
import { config } from "../config";
import { requireAdminKey, requireAuth, requireAdmin } from "../middleware/auth";
import { createError } from "../middleware/errorHandler";
import {
  runBackupNow,
  restoreFromBuffer,
  listBackups,
  isValidBackupFilename,
  looksLikePgDumpCustomFormat,
  getLastAttempt,
} from "../db/backup";
import { createUser, listUsers, updateUser, deleteUser, UserPatch } from "../services/authService";
import { listAuditLog } from "../services/auditService";
import {
  createRemoteSource,
  listRemoteSources,
  getRemoteSourceMeta,
  updateRemoteSource,
  deleteRemoteSource,
  listRemoteSourceRejects,
  RemoteSourcePatch,
} from "../services/remoteSourceService";
import { encryptionConfigured } from "../services/cryptoService";
import { pollRemoteSource } from "../services/remotePollService";

const router = Router();

/**
 * GET /admin/backups (platform extension) — read-only status on backups,
 * scheduled (the `backup` compose service) and on-demand (below) alike.
 * Any logged-in user can see it (requireAuth, not requireAdmin) — consistent
 * with "always require login" applying uniformly to the read surface.
 */
router.get("/backups", requireAuth, (_req: Request, res: Response) => {
  res.json({
    data: listBackups(),
    retentionDays: config.backups.retentionDays,
    intervalHours: config.backups.intervalHours,
    configured: !!config.backups.dir,
    // Written by the scheduled `backup` service on every run (scripts/backup.sh),
    // success or failure — lets the dashboard flag a broken backup loop instead
    // of that only ever showing up in `podman logs`. Absent for a deployment
    // that's never had the scheduled service run yet (on-demand-only usage).
    lastAttempt: getLastAttempt(),
  });
});

/** POST /admin/backups (platform extension) — trigger a pg_dump now. */
router.post(
  "/backups",
  requireAdminKey,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await runBackupNow();
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** GET /admin/backups/:filename/download (platform extension) — stream a dump file. */
router.get(
  "/backups/:filename/download",
  requireAdminKey,
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const { filename } = req.params;
      if (!isValidBackupFilename(filename)) {
        throw createError("Invalid backup filename", 400);
      }
      const dir = config.backups.dir;
      if (!dir) throw createError("Backups are not configured on this server", 501);

      const filePath = path.join(dir, filename);
      if (!fs.existsSync(filePath)) throw createError("Backup not found", 404);

      res.download(filePath, filename);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /admin/backups/restore (platform extension) — replaces the database
 * from an uploaded pg_dump (custom format). Destructive: --clean --if-exists
 * drops conflicting objects before restoring. Body is the raw .dump file.
 */
router.post(
  "/backups/restore",
  requireAdminKey,
  express.raw({ type: "application/octet-stream", limit: "200mb" }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        throw createError("Request body must be a pg_dump custom-format file", 400);
      }
      if (!looksLikePgDumpCustomFormat(buf)) {
        throw createError(
          "Doesn't look like a pg_dump custom-format file (missing PGDMP signature)",
          400
        );
      }
      await restoreFromBuffer(buf);
      res.json({ ok: true, message: "Database restored" });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * User management (platform extension) — admin-only. Powers the Users panel
 * in the dashboard's ⋯ menu; there's no separate CLI path.
 */

const scopeField = z.array(z.string()).nullable().optional();

const createUserSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["admin", "viewer"]).default("viewer"),
  allowedGroups: scopeField,
  allowedSourcePlatformIds: scopeField,
});

const updateUserSchema = z.object({
  password: z.string().min(8).optional(),
  role: z.enum(["admin", "viewer"]).optional(),
  allowedGroups: scopeField,
  allowedSourcePlatformIds: scopeField,
});

router.get("/users", requireAuth, requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await listUsers() });
  } catch (err) {
    next(err);
  }
});

router.post("/users", requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = createUserSchema.parse(req.body);
    const user = await createUser(input);
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

router.patch("/users/:id", requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) throw createError("Invalid user id", 400);

    const input = updateUserSchema.parse(req.body);
    const patch: UserPatch = {};
    if (input.password !== undefined) patch.password = input.password;
    if (input.role !== undefined) patch.role = input.role;
    if (input.allowedGroups !== undefined) patch.allowedGroups = input.allowedGroups;
    if (input.allowedSourcePlatformIds !== undefined) {
      patch.allowedSourcePlatformIds = input.allowedSourcePlatformIds;
    }

    const user = await updateUser(id, patch);
    if (!user) throw createError("User not found", 404);
    res.json(user);
  } catch (err) {
    next(err);
  }
});

router.delete("/users/:id", requireAuth, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) throw createError("Invalid user id", 400);

    if (req.user?.id === id) {
      throw createError("Cannot delete your own account while logged in as it", 400);
    }

    const deleted = await deleteUser(id);
    if (!deleted) throw createError("User not found", 404);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/audit-log (platform extension) — admin-only. Powers the Audit
 * log viewer in the dashboard's ⋯ menu. Entries are written by a global
 * middleware (middleware/audit.ts), not by this route.
 */
const auditLogQuerySchema = z.object({
  actorId: z.string().trim().min(1).optional(),
  method: z.string().trim().min(1).optional(),
  pathPrefix: z.string().trim().min(1).optional(),
  startTime: z.string().datetime({ offset: true }).optional(),
  endTime: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

router.get(
  "/audit-log",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = auditLogQuerySchema.parse(req.query);
      if (q.startTime && q.endTime && new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const page = await listAuditLog(q);
      res.json(page);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Remote source management (platform extension) — admin-only. Powers the
 * Remote sources panel in the dashboard's ⋯ menu: periodic pulls from another
 * Open-CDR-compatible platform's own GET /calls (see services/remotePollService.ts),
 * on top of this platform's existing push-based POST /calls/ingest. Secrets are
 * write-only — a create/update request accepts one, but no response ever
 * returns it, same posture the README already commits to for machine
 * credentials in this app ("never round-tripped back to the client once
 * saved"). This is the "we generated it, only chance to see it" pattern
 * (createApiKey) does NOT apply here: the admin already knows the secret,
 * they typed it in from the remote platform's own admin panel.
 */

const remoteSourceAuthSchema = z.discriminatedUnion("authType", [
  z.object({
    authType: z.literal("api_key"),
    apiKey: z.string().min(1),
    headerName: z.string().min(1).optional(),
  }),
  z.object({
    authType: z.literal("oauth2_client_credentials"),
    tokenUrl: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    scope: z.string().min(1).optional(),
  }),
  z.object({
    authType: z.literal("custom"),
    scriptBody: z.string().min(1).max(100_000),
    env: z.record(z.string()).default({}),
  }),
]);

const createRemoteSourceSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  pollIntervalMinutes: z.number().int().min(1).default(15),
  backfillFrom: z.string().datetime({ offset: true }),
  auth: remoteSourceAuthSchema,
});

const updateRemoteSourceSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
  pollIntervalMinutes: z.number().int().min(1).optional(),
  // Full replacement, not a merge — rotating a credential means resubmitting
  // the whole auth block. Omitted entirely = credential unchanged.
  auth: remoteSourceAuthSchema.optional(),
});

router.get(
  "/remote-sources",
  requireAuth,
  requireAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await listRemoteSources() });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/remote-sources",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!encryptionConfigured()) {
        throw createError("REMOTE_SOURCE_ENC_KEY is not configured on this server", 501);
      }
      const input = createRemoteSourceSchema.parse(req.body);
      const source = await createRemoteSource(input);
      res.status(201).json(source);
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/remote-sources/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) throw createError("Invalid remote source id", 400);

      const input = updateRemoteSourceSchema.parse(req.body);
      if (input.auth && !encryptionConfigured()) {
        throw createError("REMOTE_SOURCE_ENC_KEY is not configured on this server", 501);
      }

      const patch: RemoteSourcePatch = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.pollIntervalMinutes !== undefined) patch.pollIntervalMinutes = input.pollIntervalMinutes;
      if (input.auth !== undefined) patch.auth = input.auth;

      const source = await updateRemoteSource(id, patch);
      if (!source) throw createError("Remote source not found", 404);
      res.json(source);
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/remote-sources/:id",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) throw createError("Invalid remote source id", 400);

      const deleted = await deleteRemoteSource(id);
      if (!deleted) throw createError("Remote source not found", 404);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

/** POST /admin/remote-sources/:id/poll — on-demand trigger, mirrors POST /admin/backups. */
router.post(
  "/remote-sources/:id/poll",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) throw createError("Invalid remote source id", 400);

      const existing = await getRemoteSourceMeta(id);
      if (!existing) throw createError("Remote source not found", 404);

      const summary = await pollRemoteSource(id);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  }
);

const remoteSourceRejectsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

router.get(
  "/remote-sources/:id/rejects",
  requireAuth,
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) throw createError("Invalid remote source id", 400);

      const q = remoteSourceRejectsQuerySchema.parse(req.query);
      res.json(await listRemoteSourceRejects(id, q.page, q.pageSize));
    } catch (err) {
      next(err);
    }
  }
);

export default router;
