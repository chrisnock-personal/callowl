import { describe, it, expect, afterEach, afterAll } from "vitest";
import {
  createUser,
  updateUser,
  createSession,
  getUserBySession,
  createApiKey,
  getUserByApiKey,
  verifyPassword,
  recordFailedLogin,
  pruneLoginLockouts,
  pruneExpiredMfaPendingLogins,
} from "./authService";
import { query, closePool } from "../db/pool";

afterEach(async () => {
  await query("TRUNCATE users, sessions, login_lockouts, mfa_pending_logins CASCADE");
});

afterAll(async () => {
  await closePool();
});

describe("updateUser — password change revokes sessions", () => {
  it("deletes existing sessions when the password changes", async () => {
    const user = await createUser({ username: "revoke-1", password: "old-pass-123", role: "viewer" });
    const session = await createSession(user.id);
    expect(await getUserBySession(session.id)).not.toBeNull();

    await updateUser(user.id, { password: "new-pass-456" });

    expect(await getUserBySession(session.id)).toBeNull();
  });

  it("leaves sessions alone when only a non-password field changes", async () => {
    const user = await createUser({ username: "revoke-2", password: "old-pass-123", role: "viewer" });
    const session = await createSession(user.id);

    await updateUser(user.id, { role: "admin" });

    expect(await getUserBySession(session.id)).not.toBeNull();
  });

  it("the new password verifies and the old one no longer does", async () => {
    const user = await createUser({ username: "revoke-3", password: "old-pass-123", role: "viewer" });

    await updateUser(user.id, { password: "new-pass-456" });

    expect(await verifyPassword("revoke-3", "new-pass-456")).not.toBeNull();
    expect(await verifyPassword("revoke-3", "old-pass-123")).toBeNull();
  });
});

describe("mfaEnabled survives a session/API-key lookup", () => {
  it("getUserBySession reflects mfa_enabled, not just the initial login row", async () => {
    const user = await createUser({ username: "mfa-session-1", password: "pass-123", role: "viewer" });
    await query("UPDATE users SET mfa_enabled = true WHERE id = $1", [user.id]);
    const session = await createSession(user.id);

    const resolved = await getUserBySession(session.id);

    expect(resolved?.mfaEnabled).toBe(true);
  });

  it("getUserByApiKey reflects mfa_enabled too", async () => {
    const user = await createUser({ username: "mfa-key-1", password: "pass-123", role: "viewer" });
    await query("UPDATE users SET mfa_enabled = true WHERE id = $1", [user.id]);
    const { key } = await createApiKey(user.id, "test-key");

    const resolved = await getUserByApiKey(key);

    expect(resolved?.mfaEnabled).toBe(true);
  });
});

describe("pruneLoginLockouts", () => {
  it("removes only rows older than the retention window", async () => {
    await recordFailedLogin("stale-user");
    await query(
      "UPDATE login_lockouts SET last_attempt_at = now() - interval '30 days' WHERE username = $1",
      ["stale-user"]
    );
    await recordFailedLogin("fresh-user");

    const removed = await pruneLoginLockouts(7);

    expect(removed).toBe(1);
    const remaining = await query("SELECT username FROM login_lockouts");
    expect(remaining.map((r: any) => r.username)).toEqual(["fresh-user"]);
  });
});

describe("pruneExpiredMfaPendingLogins", () => {
  it("removes only expired rows", async () => {
    const user = await createUser({ username: "mfa-pending-1", password: "pass-123", role: "viewer" });
    await query(
      "INSERT INTO mfa_pending_logins (token, user_id, expires_at) VALUES ($1, $2, now() - interval '1 minute')",
      ["expired-token", user.id]
    );
    await query(
      "INSERT INTO mfa_pending_logins (token, user_id, expires_at) VALUES ($1, $2, now() + interval '5 minutes')",
      ["active-token", user.id]
    );

    const removed = await pruneExpiredMfaPendingLogins();

    expect(removed).toBe(1);
    const remaining = await query("SELECT token FROM mfa_pending_logins");
    expect(remaining.map((r: any) => r.token)).toEqual(["active-token"]);
  });
});
