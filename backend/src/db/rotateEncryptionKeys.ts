import { query } from "./pool";
import { logger } from "../logger";
import { toAuth, buildAuthConfig } from "../services/remoteSourceService";
import {
  decryptSecretWithFallback,
  encryptSecret,
  mfaEncryptionKey,
  mfaEncryptionKeyPrevious,
} from "../services/cryptoService";

/**
 * Forces every existing encrypted secret onto the *current* key, undoing
 * dependence on REMOTE_SOURCE_ENC_KEY_PREVIOUS / MFA_ENC_KEY_PREVIOUS — see
 * SECRETS_ROTATION.md for the full rotation procedure this is one step of.
 * Safe to run any time (idempotent: re-encrypting an already-current-key
 * secret just produces new ciphertext for the same plaintext), and safe to
 * run with no _PREVIOUS configured (decrypt then just uses the current key
 * on both sides — a no-op re-encryption).
 */

async function rotateRemoteSourceSecrets(): Promise<number> {
  const rows = await query<{ id: string; auth_type: string; auth_config: Record<string, unknown> }>(
    "SELECT id, auth_type, auth_config FROM remote_sources"
  );
  for (const row of rows) {
    // toAuth: decrypt (current key, falling back to previous). buildAuthConfig:
    // re-encrypt (current key only). The round trip through the same two
    // functions the app already uses for create/update *is* the rotation —
    // no separate copy of the auth-shape-branching logic.
    const auth = toAuth(row.auth_type, row.auth_config);
    const reencrypted = buildAuthConfig(auth);
    await query("UPDATE remote_sources SET auth_config = $1 WHERE id = $2", [
      JSON.stringify(reencrypted),
      row.id,
    ]);
  }
  return rows.length;
}

async function rotateMfaSecrets(): Promise<number> {
  const rows = await query<{ id: string; mfa_secret_encrypted: string }>(
    "SELECT id, mfa_secret_encrypted FROM users WHERE mfa_secret_encrypted IS NOT NULL"
  );
  const key = mfaEncryptionKey();
  const previousKey = mfaEncryptionKeyPrevious();
  for (const row of rows) {
    const secret = decryptSecretWithFallback(row.mfa_secret_encrypted, key, previousKey);
    const reencrypted = encryptSecret(secret, key);
    await query("UPDATE users SET mfa_secret_encrypted = $1 WHERE id = $2", [reencrypted, row.id]);
  }
  return rows.length;
}

export async function rotateEncryptionKeys(): Promise<{ remoteSources: number; mfaSecrets: number }> {
  const remoteSources = await rotateRemoteSourceSecrets();
  const mfaSecrets = await rotateMfaSecrets();
  logger.info("Encryption key rotation complete", { remoteSources, mfaSecrets });
  return { remoteSources, mfaSecrets };
}

// Standalone runner (npm run rotate-encryption-keys)
if (require.main === module) {
  rotateEncryptionKeys()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("Encryption key rotation failed", { err });
      process.exit(1);
    });
}
