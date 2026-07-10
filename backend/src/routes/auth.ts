import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  verifyPassword,
  createSession,
  destroySession,
  createApiKey,
  listApiKeys,
  deleteApiKey,
  User,
} from "../services/authService";
import { requireAuth, SESSION_COOKIE } from "../middleware/auth";
import { createError } from "../middleware/errorHandler";
import { config } from "../config";

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
});

/** Never send password_hash to the client. */
function publicUser(user: User) {
  return {
    username: user.username,
    role: user.role,
    allowedGroups: user.allowedGroups,
    allowedSourcePlatformIds: user.allowedSourcePlatformIds,
  };
}

// POST /auth/login
router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const user = await verifyPassword(username, password);
    if (!user) {
      res.status(401).json({
        error: { code: "unauthorized", message: "Invalid username or password" },
      });
      return;
    }
    const session = await createSession(user.id);
    res.cookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.auth.cookieSecure,
      expires: session.expiresAt,
      path: "/",
    });
    res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout
router.post("/logout", async (req: Request, res: Response) => {
  const sessionId = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (sessionId) await destroySession(sessionId);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// GET /auth/me
router.get("/me", requireAuth, (req: Request, res: Response) => {
  res.json(publicUser(req.user!));
});

// ─── API keys ─────────────────────────────────────────────────────────────
// Self-service — every logged-in user manages their own keys (not admin-only).
// A key acts as its owner: same role, same scope, enforced the same way a
// session cookie is. See services/authService.ts and middleware/auth.ts.

// GET /auth/api-keys
router.get("/api-keys", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await listApiKeys(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

// POST /auth/api-keys — returns the raw key once; never retrievable again.
router.post("/api-keys", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = createApiKeySchema.parse(req.body);
    const created = await createApiKey(req.user!.id, name);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// DELETE /auth/api-keys/{id}
router.delete(
  "/api-keys/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) throw createError("Invalid API key id", 400);

      const deleted = await deleteApiKey(req.user!.id, id);
      if (!deleted) throw createError("API key not found", 404);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
