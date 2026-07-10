import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { getUserBySession, getUserByApiKey, User } from "../services/authService";

export const SESSION_COOKIE = "session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Optional-key gate, shared shape for ingest actions: if the configured key is
 * unset (dev/local mode), auth is disabled. Otherwise clients send it as
 * X-API-Key.
 */
function requireKey(key: string | undefined, action: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!key) {
      next();
      return;
    }

    const providedKey = req.headers["x-api-key"] as string | undefined;
    if (providedKey !== key) {
      res.status(401).json({
        error: {
          code: "unauthorized",
          message: `Provide a valid X-API-Key header to ${action}`,
        },
      });
      return;
    }
    next();
  };
}

/**
 * Protects POST /calls/ingest. If INGEST_API_KEY is unset, stays fully open
 * (unchanged, dev/local default). If set, accepts either an exact match on
 * INGEST_API_KEY or a valid per-user API key (any role — ingest isn't
 * role-gated, so a key shouldn't be either) as X-API-Key.
 */
export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!config.ingestApiKey) {
    next();
    return;
  }
  const providedKey = req.headers["x-api-key"] as string | undefined;
  if (providedKey === config.ingestApiKey) {
    next();
    return;
  }
  const user = providedKey ? await getUserByApiKey(providedKey) : null;
  if (user) {
    req.user = user;
    next();
    return;
  }
  res.status(401).json({
    error: {
      code: "unauthorized",
      message: "Provide a valid X-API-Key header to ingest records",
    },
  });
}

/**
 * Requires a logged-in dashboard/API user. Tries the session cookie first,
 * then falls back to a per-user API key via X-API-Key — either way req.user
 * ends up set identically, so scopeFilters and everything downstream doesn't
 * need to know which path authenticated the request. The read API (GET
 * /calls, /statistics/*) sits behind this — health checks and API docs
 * deliberately don't (see index.ts), and POST /calls/ingest uses requireApiKey
 * instead (INGEST_API_KEY or a per-user key), since that's machine-to-machine,
 * not a person logging in.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const sessionId = req.cookies?.[SESSION_COOKIE] as string | undefined;
  let user = sessionId ? await getUserBySession(sessionId) : null;

  if (!user) {
    const apiKey = req.headers["x-api-key"] as string | undefined;
    user = apiKey ? await getUserByApiKey(apiKey) : null;
  }

  if (!user) {
    res.status(401).json({
      error: { code: "unauthorized", message: "Log in to continue" },
    });
    return;
  }
  req.user = user;
  next();
}

/** requireAuth + admin role. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({
      error: { code: "forbidden", message: "Admin role required" },
    });
    return;
  }
  next();
}

/**
 * Protects the admin backup/restore actions (not the read-only status list,
 * which just needs requireAuth like the rest of the read API). Passes if
 * *either* ADMIN_API_KEY matches (unchanged from before — existing scripts/
 * automation keep working) *or* the caller is logged in as an admin, so the
 * dashboard doesn't need a separate key pasted in once real accounts exist.
 */
export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role === "admin") {
    next();
    return;
  }
  requireKey(config.adminApiKey, "perform this action")(req, res, next);
}

/**
 * Constrains a filter value to what a user is allowed to see: unrestricted
 * (null) users pass the request through unchanged; a scoped user without an
 * explicit request defaults to their full allowed set; a scoped user who did
 * request specific values gets the intersection (never able to widen past
 * their own scope by asking for more).
 */
function scopeList(allowed: string[] | null | undefined, requested?: string[]): string[] | undefined {
  if (!allowed) return requested;
  if (!requested || requested.length === 0) return allowed;
  return requested.filter((v) => allowed.includes(v));
}

export function scopeFilters(
  user: User,
  filters: { groups?: string[]; sourcePlatformId?: string[] }
): { groups?: string[]; sourcePlatformId?: string[] } {
  return {
    groups: scopeList(user.allowedGroups, filters.groups),
    sourcePlatformId: scopeList(user.allowedSourcePlatformIds, filters.sourcePlatformId),
  };
}
