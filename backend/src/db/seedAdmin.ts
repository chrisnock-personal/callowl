import crypto from "crypto";
import { config } from "../config";
import { countUsers, createUser } from "../services/authService";

/**
 * Creates the first admin account on a fresh install. "Always require login"
 * means there's no open fallback, so something has to get a real operator
 * into an empty users table. If BOOTSTRAP_ADMIN_PASSWORD isn't set, a random
 * one is generated and printed once — loud and unmissable — rather than
 * defaulting to a guessable password. Skips entirely once any user exists.
 */
export async function seedAdmin(): Promise<void> {
  if ((await countUsers()) > 0) return;

  const username = config.auth.bootstrapAdminUsername;
  // Compose passes unset env vars through as "" (${VAR:-}), not undefined, so
  // this has to treat blank the same as unset — a bare ?? would let an empty
  // string silently become the admin's real password.
  const generated = !config.auth.bootstrapAdminPassword;
  const password = config.auth.bootstrapAdminPassword || crypto.randomBytes(12).toString("base64url");

  await createUser({ username, password, role: "admin" });

  console.log("");
  console.log("🔐  Bootstrap admin account created:");
  console.log(`    Username: ${username}`);
  if (generated) {
    console.log(`    Password: ${password}`);
    console.log("    (generated — save it now, it will not be shown again)");
  } else {
    console.log("    Password: <from BOOTSTRAP_ADMIN_PASSWORD>");
  }
  console.log("");
}
