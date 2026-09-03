import { describe, it, expect, afterEach, afterAll } from "vitest";
import { createUser, updateUser, createSession, getUserBySession, verifyPassword } from "./authService";
import { query, closePool } from "../db/pool";

afterEach(async () => {
  await query("TRUNCATE users, sessions CASCADE");
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
