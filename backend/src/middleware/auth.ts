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
 * Optional-key gate, shared shape for ingest actions: if no keys are
 * configured (dev/local mode), auth is disabled. Otherwise clients send one
 * of the currently-valid keys as X-API-Key — accepting a list (not just one)
 * is what lets a key be rotated without a flag-day cutover, see
 * SECRETS_ROTATION.md.
 */
function requireKey(keys: string[], action: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (keys.length === 0) {
      next();
      return;
    }

    const providedKey = req.headers["x-api-key"] as string | undefined;
    if (!providedKey || !keys.includes(providedKey)) {
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
 * Protects POST /calls/ingest. If no INGEST_API_KEY is configured, stays
 * fully open (unchanged, dev/local default). If set, accepts either a match
 * on any currently-valid INGEST_API_KEY value or a valid per-user API key
 * (any role — ingest isn't role-gated, so a key shouldn't be either) as
 * X-API-Key.
 */
export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (config.ingestApiKeys.length === 0) {
    next();
    return;
  }
  const providedKey = req.headers["x-api-key"] as string | undefined;
  if (providedKey && config.ingestApiKeys.includes(providedKey)) {
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
 * Protects the admin backup/restore/TLS-replace actions (not the read-only
 * status list, which just needs requireAuth like the rest of the read API).
 * Passes if *either* the caller is logged in as an admin *or* a currently-
 * valid ADMIN_API_KEY was provided.
 *
 * Resolves the session cookie itself rather than depending on requireAuth
 * having already run in front of it on these routes (it deliberately isn't
 * — stacking requireAuth first would reject a caller authenticating via the
 * shared ADMIN_API_KEY alone, since requireAuth's own fallback only knows
 * about *per-user* API keys, not this shared one). Found the hard way while
 * fixing the bug below: since req.user was never populated on these routes
 * at all, "or the caller is logged in as an admin" had *never* actually
 * worked here even before that fix — the only reason a real admin session
 * ever appeared to grant access was the same over-permissive fallback that
 * let an anonymous caller in too.
 *
 * Deliberately does NOT reuse requireKey above despite the similar shape:
 * requireKey's "no keys configured => next()" is correct for requireApiKey's
 * ingest gate (fully open is the documented local-lab default there), but
 * wrong here — restore replaces the whole database and TLS-replace changes
 * what the whole site serves, so an unconfigured ADMIN_API_KEY must fail
 * closed (require an admin session), not open to every anonymous caller.
 * Reusing requireKey previously did exactly that: a fully credential-less
 * request could trigger pg_restore or replace the TLS cert whenever an
 * operator simply hadn't set ADMIN_API_KEY — the out-of-the-box default —
 * confirmed live against a real running instance before this fix.
 */
export async function requireAdminKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    const sessionId = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const user = sessionId ? await getUserBySession(sessionId) : null;
    if (user) req.user = user;
  }
  if (req.user?.role === "admin") {
    next();
    return;
  }
  const providedKey = req.headers["x-api-key"] as string | undefined;
  if (providedKey && config.adminApiKeys.includes(providedKey)) {
    next();
    return;
  }
  res.status(401).json({
    error: {
      code: "unauthorized",
      message: "Log in as an admin, or provide a valid X-API-Key header, to perform this action",
    },
  });
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
