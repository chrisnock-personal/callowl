import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  getStatisticsSummary,
  getTopTalkers,
  getThroughput,
  getThroughputByOutcome,
  getPlatformBreakdown,
  getHandleTimeTrend,
  getAgentHandleTime,
  getQueueWaitTrend,
  getQueueWaitBreakdown,
  getWorstMosCalls,
  getIvrTimeTrend,
  getIvrTimeByIvr,
  InsightsFilters,
} from "../services/statisticsService";
import { createError } from "../middleware/errorHandler";
import { requireAuth, scopeFilters } from "../middleware/auth";

const router = Router();

const summaryQuerySchema = z.object({
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
});

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

// Shared window + read-API filters for the insights endpoints (platform
// extensions — not part of the standard's documented API).
const insightsQuerySchema = z.object({
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  mediaType: csv,
  groups: csv,
  excludeGroups: csv,
  sourcePlatformId: csv,
});

function tenant(req: Request): string | undefined {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length ? t : undefined;
}

function filtersFrom(
  q: z.infer<typeof insightsQuerySchema>,
  req: Request
): InsightsFilters {
  const scoped = scopeFilters(req.user!, {
    groups: q.groups,
    sourcePlatformId: q.sourcePlatformId,
  });
  return {
    startTime: q.startTime,
    endTime: q.endTime,
    mediaType: q.mediaType,
    groups: scoped.groups,
    excludeGroups: q.excludeGroups,
    sourcePlatformId: scoped.sourcePlatformId,
    tenantId: tenant(req),
  };
}

// GET /statistics/summary
router.get(
  "/summary",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = summaryQuerySchema.parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const scoped = scopeFilters(req.user!, {});
      const summary = await getStatisticsSummary({
        startTime: q.startTime,
        endTime: q.endTime,
        tenantId: tenant(req),
        groups: scoped.groups,
        sourcePlatformId: scoped.sourcePlatformId,
      });
      res.json(summary);
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/top-talkers  (platform extension)
router.get(
  "/top-talkers",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema
        .extend({
          limit: z.coerce.number().int().min(1).max(50).default(10),
          scope: z.enum(["internal", "external", "all"]).default("all"),
        })
        .parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getTopTalkers(filtersFrom(q, req), q.limit, q.scope);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/throughput  (platform extension)
router.get(
  "/throughput",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema
        .extend({ bucket: z.enum(["hour", "day"]).default("day") })
        .parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getThroughput(filtersFrom(q, req), q.bucket);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/throughput/by-outcome  (platform extension)
router.get(
  "/throughput/by-outcome",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema
        .extend({ bucket: z.enum(["hour", "day"]).default("day") })
        .parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getThroughputByOutcome(filtersFrom(q, req), q.bucket);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/by-platform  (platform extension)
router.get(
  "/by-platform",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema.parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getPlatformBreakdown(filtersFrom(q, req));
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/handle-time  (platform extension)
router.get(
  "/handle-time",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema
        .extend({ bucket: z.enum(["hour", "day"]).default("day") })
        .parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getHandleTimeTrend(filtersFrom(q, req), q.bucket);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/handle-time/by-agent  (platform extension)
router.get(
  "/handle-time/by-agent",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema
        .extend({ limit: z.coerce.number().int().min(1).max(50).default(10) })
        .parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getAgentHandleTime(filtersFrom(q, req), q.limit);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/queue-wait  (platform extension)
router.get(
  "/queue-wait",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema
        .extend({ bucket: z.enum(["hour", "day"]).default("day") })
        .parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getQueueWaitTrend(filtersFrom(q, req), q.bucket);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/queue-wait/by-queue  (platform extension)
router.get(
  "/queue-wait/by-queue",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema
        .extend({ limit: z.coerce.number().int().min(1).max(50).default(10) })
        .parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getQueueWaitBreakdown(filtersFrom(q, req), q.limit);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/worst-mos  (platform extension)
router.get(
  "/worst-mos",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema
        .extend({ limit: z.coerce.number().int().min(1).max(50).default(10) })
        .parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getWorstMosCalls(filtersFrom(q, req), q.limit);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/ivr-time  (platform extension)
router.get(
  "/ivr-time",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema
        .extend({ bucket: z.enum(["hour", "day"]).default("day") })
        .parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getIvrTimeTrend(filtersFrom(q, req), q.bucket);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /statistics/ivr-time/by-ivr  (platform extension)
router.get(
  "/ivr-time/by-ivr",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = insightsQuerySchema
        .extend({ limit: z.coerce.number().int().min(1).max(50).default(10) })
        .parse(req.query);
      if (new Date(q.endTime) <= new Date(q.startTime)) {
        throw createError("endTime must be after startTime", 400);
      }
      const data = await getIvrTimeByIvr(filtersFrom(q, req), q.limit);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
