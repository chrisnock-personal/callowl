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
} from "../db/backup";
import { createUser, listUsers, updateUser, deleteUser, UserPatch } from "../services/authService";
import { listAuditLog } from "../services/auditService";

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

export default router;
