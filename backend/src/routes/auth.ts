import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  verifyPassword,
  createSession,
  destroySession,
  createApiKey,
  listApiKeys,
  deleteApiKey,
  checkLockout,
  recordFailedLogin,
  recordSuccessfulLogin,
  createMfaPendingLogin,
  getMfaPendingLoginUserId,
  deleteMfaPendingLogin,
  getUserById,
  User,
} from "../services/authService";
import {
  beginEnrollment,
  confirmEnrollment,
  disableMfa,
  verifyMfaCode,
} from "../services/mfaService";
import { mfaEncryptionConfigured } from "../services/cryptoService";
import { requireAuth, SESSION_COOKIE } from "../middleware/auth";
import { createError } from "../middleware/errorHandler";
import { config } from "../config";

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const mfaLoginSchema = z.object({
  pendingToken: z.string().min(1),
  code: z.string().min(1),
});

const mfaConfirmSchema = z.object({
  code: z.string().min(1),
});

const mfaDisableSchema = z.object({
  password: z.string().min(1),
  code: z.string().min(1),
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
    mfaEnabled: user.mfaEnabled,
  };
}

function setSessionCookie(res: Response, session: { id: string; expiresAt: Date }) {
  res.cookie(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.auth.cookieSecure,
    expires: session.expiresAt,
    path: "/",
  });
}

// POST /auth/login
router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = loginSchema.parse(req.body);

    // Checked before verifyPassword — a locked username never reaches
    // bcrypt.compare, and this responds identically whether or not the
    // username is real (see authService.ts's checkLockout doc comment).
    const lockout = await checkLockout(username);
    if (lockout.locked) {
      res.status(423).json({
        error: {
          code: "account_locked",
          message: "Too many failed attempts — try again later",
        },
      });
      return;
    }

    const user = await verifyPassword(username, password);
    if (!user) {
      await recordFailedLogin(username);
      res.status(401).json({
        error: { code: "unauthorized", message: "Invalid username or password" },
      });
      return;
    }

    if (user.mfaEnabled) {
      const pendingToken = await createMfaPendingLogin(user.id);
      res.json({ mfaRequired: true, pendingToken });
      return;
    }

    await recordSuccessfulLogin(username);
    const session = await createSession(user.id);
    setSessionCookie(res, session);
    res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

// POST /auth/login/mfa — second step when POST /auth/login returned mfaRequired.
router.post("/login/mfa", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { pendingToken, code } = mfaLoginSchema.parse(req.body);

    const userId = await getMfaPendingLoginUserId(pendingToken);
    if (!userId) {
      res.status(401).json({
        error: { code: "unauthorized", message: "Login session expired — start again" },
      });
      return;
    }
    const user = await getUserById(userId);
    if (!user) {
      res.status(401).json({
        error: { code: "unauthorized", message: "Invalid username or password" },
      });
      return;
    }

    // Same lockout as the password step — a valid pendingToken doesn't
    // exempt repeated wrong codes from counting toward the threshold, since
    // guessing a 6-digit code is itself brute-forceable.
    const lockout = await checkLockout(user.username);
    if (lockout.locked) {
      res.status(423).json({
        error: {
          code: "account_locked",
          message: "Too many failed attempts — try again later",
        },
      });
      return;
    }

    const codeOk = await verifyMfaCode(userId, code);
    if (!codeOk) {
      await recordFailedLogin(user.username);
      res.status(401).json({ error: { code: "unauthorized", message: "Invalid code" } });
      return;
    }

    await deleteMfaPendingLogin(pendingToken);
    await recordSuccessfulLogin(user.username);
    const session = await createSession(user.id);
    setSessionCookie(res, session);
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

// ─── MFA (self-service) ─────────────────────────────────────────────────────
// Every logged-in user manages their own MFA enrollment — admins additionally
// get a reset action for the "lost my device" case (see routes/admin.ts).

// POST /auth/mfa/setup — begins enrollment, returns the secret + otpauth URI.
// Not yet enabled until POST /auth/mfa/confirm proves a valid code.
router.post("/mfa/setup", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!mfaEncryptionConfigured()) {
      throw createError("MFA_ENC_KEY is not configured on this server", 501);
    }
    const enrollment = await beginEnrollment(req.user!.id);
    res.json(enrollment);
  } catch (err) {
    next(err);
  }
});

// POST /auth/mfa/confirm — completes enrollment, returns one-time recovery codes.
router.post(
  "/mfa/confirm",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = mfaConfirmSchema.parse(req.body);
      const recoveryCodes = await confirmEnrollment(req.user!.id, code);
      res.json({ recoveryCodes });
    } catch (err) {
      next(err);
    }
  }
);

// POST /auth/mfa/disable — requires the current password *and* a valid code,
// not just an active session (see mfaService.ts's disableMfa doc comment).
router.post(
  "/mfa/disable",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { password, code } = mfaDisableSchema.parse(req.body);
      await disableMfa(req.user!.id, password, code);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

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
