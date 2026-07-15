import { Request, Response, NextFunction } from "express";
import { httpRequestDuration } from "../metrics";

/**
 * Records request duration/count/status for every request. Same res.on("finish")
 * shape as middleware/audit.ts, mounted globally before the routers.
 *
 * Route label uses req.route?.path prefixed with req.baseUrl (e.g.
 * "/admin/users/:id"), not the raw path — labeling by raw path would cause
 * unbounded cardinality in Prometheus for any path-param route (/calls/{callId},
 * /admin/users/{id}, etc.), a real correctness issue, not just a style choice.
 * Falls back to a fixed "unmatched" label for 404s, since no route pattern
 * exists to use there.
 */
export function metrics(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe(
      { method: req.method, route, status_code: res.statusCode },
      durationSeconds
    );
  });

  next();
}
