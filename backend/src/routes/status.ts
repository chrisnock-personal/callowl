import { Router, Request, Response, NextFunction } from "express";
import { createError } from "../middleware/errorHandler";
import { isStatusPageEnabled, getPublicStatus } from "../services/statusPageService";

const router = Router();

/**
 * GET /status (platform extension) — public, no auth at all, off by default
 * (toggled from the dashboard's ⋯ menu → Status page, admin only — see
 * POST /admin/status-page). 404s rather than 200-with-a-flag when disabled,
 * so a naive uptime monitor pointed at this URL can't mistake "not turned on"
 * for "healthy."
 */
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await isStatusPageEnabled())) {
      throw createError("Status page is not enabled", 404);
    }
    res.json(await getPublicStatus());
  } catch (err) {
    next(err);
  }
});

export default router;
