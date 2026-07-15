import crypto from "crypto";
import { generateSecret, generateURI, verify } from "otplib";
import { query, queryOne } from "../db/pool";
import {
  encryptSecret,
  decryptSecretWithFallback,
  mfaEncryptionKey,
  mfaEncryptionKeyPrevious,
} from "./cryptoService";
import { getUserById, verifyPassword } from "./authService";
import { createError } from "../middleware/errorHandler";

const ISSUER = "Open CDR Platform";

export interface MfaEnrollment {
  secret: string;
  otpauthUri: string;
}

/**
 * Generates a secret and stores it encrypted, but mfa_enabled stays false
 * until confirmEnrollment proves the user can actually generate a valid
 * code — an abandoned enrollment never silently starts requiring a second
 * factor.
 */
export async function beginEnrollment(userId: number): Promise<MfaEnrollment> {
  const user = await getUserById(userId);
  if (!user) throw createError("User not found", 404);
  if (user.mfaEnabled) {
    throw createError("MFA is already enabled — disable it first to re-enroll", 409);
  }

  const secret = generateSecret();
  const otpauthUri = generateURI({ issuer: ISSUER, label: user.username, secret });
  await query(`UPDATE users SET mfa_secret_encrypted = $1 WHERE id = $2`, [
    encryptSecret(secret, mfaEncryptionKey()),
    userId,
  ]);
  return { secret, otpauthUri };
}

function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function generateRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => crypto.randomBytes(5).toString("hex"));
}

// otplib's verify() throws (TokenLengthError/TokenFormatError) for a
// malformed token — e.g. a 10-character recovery code submitted where a
// 6-digit TOTP code was expected — rather than returning { valid: false }.
// Without catching that, a recovery-code attempt would 500 instead of
// falling through to the recovery-code check in verifyMfaCode below.
async function isValidTotp(secret: string, token: string): Promise<boolean> {
  try {
    const result = await verify({ secret, token });
    return result.valid;
  } catch {
    return false;
  }
}

/** Verifies the enrollment code, flips mfa_enabled on, and returns one-time recovery codes. */
export async function confirmEnrollment(userId: number, code: string): Promise<string[]> {
  const row = await queryOne<{ mfa_secret_encrypted: string | null }>(
    `SELECT mfa_secret_encrypted FROM users WHERE id = $1`,
    [userId]
  );
  if (!row?.mfa_secret_encrypted) throw createError("No MFA enrollment in progress", 400);

  const secret = decryptSecretWithFallback(
    row.mfa_secret_encrypted,
    mfaEncryptionKey(),
    mfaEncryptionKeyPrevious()
  );
  if (!(await isValidTotp(secret, code))) throw createError("Invalid code", 401);

  await query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [userId]);

  // Shown to the user exactly once, same as an API key's raw value at creation.
  const codes = generateRecoveryCodes();
  const values = codes.map((_, i) => `($1, $${i + 2})`).join(", ");
  await query(
    `INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ${values}`,
    [userId, ...codes.map(hashRecoveryCode)]
  );
  return codes;
}

/** TOTP first, falling back to an unused recovery code (one-time — claimed atomically). */
export async function verifyMfaCode(userId: number, code: string): Promise<boolean> {
  const row = await queryOne<{ mfa_secret_encrypted: string | null; mfa_enabled: boolean }>(
    `SELECT mfa_secret_encrypted, mfa_enabled FROM users WHERE id = $1`,
    [userId]
  );
  if (!row?.mfa_enabled || !row.mfa_secret_encrypted) return false;

  const secret = decryptSecretWithFallback(
    row.mfa_secret_encrypted,
    mfaEncryptionKey(),
    mfaEncryptionKeyPrevious()
  );
  if (await isValidTotp(secret, code)) return true;

  const recoveryRows = await query<{ id: string }>(
    `UPDATE mfa_recovery_codes
        SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      RETURNING id`,
    [userId, hashRecoveryCode(code)]
  );
  return recoveryRows.length > 0;
}

/**
 * Requires the current password *and* a valid code (TOTP or recovery) —
 * not just an active session — so a hijacked session can't silently turn
 * off the second factor it's supposed to be protected by.
 */
export async function disableMfa(userId: number, password: string, code: string): Promise<void> {
  const user = await getUserById(userId);
  if (!user) throw createError("User not found", 404);

  const passwordOk = await verifyPassword(user.username, password);
  if (!passwordOk) throw createError("Incorrect password", 401);

  const codeOk = await verifyMfaCode(userId, code);
  if (!codeOk) throw createError("Invalid code", 401);

  await query(`UPDATE users SET mfa_enabled = false, mfa_secret_encrypted = NULL WHERE id = $1`, [
    userId,
  ]);
  await query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
}

/** Admin escape hatch for "lost my device" — same trust level as the existing admin password reset. */
export async function adminResetMfa(userId: number): Promise<void> {
  await query(`UPDATE users SET mfa_enabled = false, mfa_secret_encrypted = NULL WHERE id = $1`, [
    userId,
  ]);
  await query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
}
