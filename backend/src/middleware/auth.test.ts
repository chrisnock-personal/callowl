import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { Request, Response } from "express";
import { requireAdminKey, SESSION_COOKIE } from "./auth";
import { createUser, createSession } from "../services/authService";
import { query, closePool } from "../db/pool";

afterEach(async () => {
  await query("TRUNCATE users, sessions CASCADE");
});

afterAll(async () => {
  await closePool();
});

function fakeReq(cookieSessionId?: string): Request {
  return {
    cookies: cookieSessionId ? { [SESSION_COOKIE]: cookieSessionId } : {},
    headers: {},
  } as unknown as Request;
}

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: any = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

// Regression coverage for a real, live-confirmed vulnerability: requireAdminKey
// used to fall through to an unconditional next() whenever ADMIN_API_KEY was
// unset (the shipped default), letting a fully credential-less request trigger
// destructive backup restore or TLS-cert replacement. See the doc comment on
// requireAdminKey itself for the full story.
describe("requireAdminKey", () => {
  it("rejects a request with no session and no API key", async () => {
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();

    await requireAdminKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("allows a real admin session", async () => {
    const admin = await createUser({ username: "mw-admin-1", password: "pass-123", role: "admin" });
    const session = await createSession(admin.id);
    const req = fakeReq(session.id);
    const res = fakeRes();
    const next = vi.fn();

    await requireAdminKey(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it("rejects a real session belonging to a non-admin viewer", async () => {
    const viewer = await createUser({ username: "mw-viewer-1", password: "pass-123", role: "viewer" });
    const session = await createSession(viewer.id);
    const req = fakeReq(session.id);
    const res = fakeRes();
    const next = vi.fn();

    await requireAdminKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
