import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { listCallRecords, getCallRecord } from "../services/cdrService";
import { ingestRecords } from "../services/ingestService";
import { ingestBodySchema } from "../schemas/cdr";
import { requireApiKey, requireAuth, scopeFilters } from "../middleware/auth";
import { createError } from "../middleware/errorHandler";

const router = Router();

const csv = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined
  );

const listQuerySchema = z.object({
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  mediaType: csv,
  groups: csv,
  excludeGroups: csv,
  // Platform extensions — not part of the standard's documented GET /calls filters.
  sourcePlatformId: csv,
  participant: z.string().trim().min(1).optional(),
  queue: csv,
  ivr: csv,
  advanced: z.string().trim().min(1).optional(),
  sort: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(100),
});

function tenant(req: Request): string | undefined {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length ? t : undefined;
}

// GET /calls
router.get("/", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = listQuerySchema.parse(req.query);
    if (new Date(q.endTime) <= new Date(q.startTime)) {
      throw createError("endTime must be after startTime", 400);
    }
    const scoped = scopeFilters(req.user!, {
      groups: q.groups,
      sourcePlatformId: q.sourcePlatformId,
    });
    const page = await listCallRecords({
      startTime: q.startTime,
      endTime: q.endTime,
      mediaType: q.mediaType,
      groups: scoped.groups,
      excludeGroups: q.excludeGroups,
      tenantId: tenant(req),
      sourcePlatformId: scoped.sourcePlatformId,
      participant: q.participant,
      queue: q.queue,
      ivr: q.ivr,
      advanced: q.advanced,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize,
    });
    res.locals.auditRecordCount = page.pagination.totalRecords;
    res.json(page);
  } catch (err) {
    next(err);
  }
});

// POST /calls/ingest  (platform extension — the standard's read API is GET-only)
router.post(
  "/ingest",
  requireApiKey,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = ingestBodySchema.parse(req.body);
      const results = await ingestRecords(body);
      res.locals.auditRecordCount = results.length;
      res.status(201).json({
        accepted: results.length,
        created: results.filter((r) => r.action === "created").length,
        updated: results.filter((r) => r.action === "updated").length,
        results,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /calls/{callId}
router.get(
  "/:callId",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      const record = await getCallRecord(req.params.callId, tenant(req), {
        groups: user.allowedGroups ?? undefined,
        sourcePlatformId: user.allowedSourcePlatformIds ?? undefined,
      });
      if (!record) throw createError("Call record not found", 404);
      res.json(record);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
