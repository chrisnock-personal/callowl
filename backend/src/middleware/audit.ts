import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { logEvent, ActorType } from "../services/auditService";

const BASE = config.apiBasePath;

// No compliance value, would just be noise: health checks, metrics scrapes,
// API docs, and the "am I logged in" ping the dashboard fires on every page
// load/reload.
const SKIP_EXACT = new Set([
  `${BASE}/health`,
  `${BASE}/metrics`,
  `${BASE}/openapi.json`,
  `${BASE}/auth/me`,
]);
const SKIP_PREFIXES = [`${BASE}/docs`];

function resolveActor(req: Request): { type: ActorType; id: string | null } {
  // Session cookie or a per-user API key both resolve to req.user via
  // requireAuth/requireApiKey — either way this attributes to one person.
  if (req.user) return { type: "user", id: req.user.username };

  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey && config.ingestApiKey && apiKey === config.ingestApiKey) {
    return { type: "ingest_key", id: null };
  }
  if (apiKey && config.adminApiKey && apiKey === config.adminApiKey) {
    return { type: "admin_key", id: null };
  }
  // No valid credential at all — a failed login attempt or a bare 401 looks
  // like this, which is exactly the case compliance logging most wants to
  // catch, so it's a first-class actor type rather than being dropped.
  return { type: "anonymous", id: null };
}

/**
 * Logs every request that reaches a route with compliance value: who (or
 * what), when, method/path, the resulting status, and — for handlers that
 * opt in via res.locals.auditRecordCount — how many records were involved.
 * Hooked on res.on("finish") rather than called explicitly from each route,
 * so a new endpoint can't silently end up unaudited.
 *
 * Mounted globally, before the routers. req.user is still read lazily inside
 * the finish callback, by which point requireAuth/requireApiKey have already
 * run and populated it — mount order relative to them doesn't matter.
 */
export function auditLog(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;
  if (SKIP_EXACT.has(path) || SKIP_PREFIXES.some((p) => path.startsWith(p))) {
    next();
    return;
  }

  res.on("finish", () => {
    const actor = resolveActor(req);
    const params: Record<string, unknown> = { ...req.query };
    // Never logs the password — only the attempted username, so a failed
    // login is still attributable to who it claimed to be.
    if (path === `${BASE}/auth/login` && req.body && typeof req.body.username === "string") {
      params.username = req.body.username;
    }

    logEvent({
      actorType: actor.type,
      actorId: actor.id,
      method: req.method,
      path,
      statusCode: res.statusCode,
      recordCount: (res.locals.auditRecordCount as number | undefined) ?? null,
      params: Object.keys(params).length ? params : null,
      ipAddress: req.ip ?? null,
    }).catch(() => {});
  });

  next();
}
