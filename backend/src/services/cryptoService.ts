import crypto from "crypto";
import { config } from "../config";

/**
 * Reversible encryption for secrets this platform must read back in
 * plaintext (a remote source's API key/OAuth2 client secret; a user's TOTP
 * MFA secret) — distinct from authService.ts's API-key hashing, which is
 * verify-only. AES-256-GCM, keyed per call site (see the two resolvers
 * below) rather than one shared key — each feature has its own env var so
 * a deployment using only one of them doesn't need to configure a key named
 * for the other, and rotating one doesn't force-invalidate the other's
 * stored secrets too. Key rotation within a single feature is still out of
 * scope for v1, same posture as ADMIN_API_KEY having none — rotating a key
 * invalidates every secret it sealed; re-enter/re-enroll them after.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size

function resolveKey(envValue: string | undefined, envVarName: string): Buffer {
  if (!envValue) {
    throw new Error(`${envVarName} is not configured — required to store or use this secret`);
  }
  const key = Buffer.from(envValue, "base64");
  if (key.length !== 32) {
    throw new Error(`${envVarName} must decode to exactly 32 bytes (openssl rand -base64 32)`);
  }
  return key;
}

export function remoteSourceEncryptionKey(): Buffer {
  return resolveKey(config.remoteSources.encryptionKey, "REMOTE_SOURCE_ENC_KEY");
}

export function mfaEncryptionKey(): Buffer {
  return resolveKey(config.mfa.encryptionKey, "MFA_ENC_KEY");
}

// Set during a rotation window (see SECRETS_ROTATION.md) so decrypt can fall
// back to the key that sealed existing data while new writes move onto the
// current key. undefined (not a throw) when unset — a rotation window is
// optional, unlike the primary key.
export function remoteSourceEncryptionKeyPrevious(): Buffer | undefined {
  return config.remoteSources.encryptionKeyPrevious
    ? resolveKey(config.remoteSources.encryptionKeyPrevious, "REMOTE_SOURCE_ENC_KEY_PREVIOUS")
    : undefined;
}

export function mfaEncryptionKeyPrevious(): Buffer | undefined {
  return config.mfa.encryptionKeyPrevious
    ? resolveKey(config.mfa.encryptionKeyPrevious, "MFA_ENC_KEY_PREVIOUS")
    : undefined;
}

/** Returns "iv:authTag:ciphertext", each part base64. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(sealed: string, key: Buffer): string {
  const [ivB64, authTagB64, ciphertextB64] = sealed.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted secret — expected iv:authTag:ciphertext");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * Tries the current key first, falls back to the previous one if that fails
 * — the read side of a rotation window (see SECRETS_ROTATION.md). Encryption
 * has no equivalent: writes always use the current key only, so every write
 * (a new/updated secret) moves data forward onto it automatically. If both
 * attempts fail, the error from the *previous*-key attempt propagates (a
 * genuinely wrong/corrupt secret, not just "hasn't been rotated yet").
 */
export function decryptSecretWithFallback(sealed: string, primary: Buffer, previous?: Buffer): string {
  try {
    return decryptSecret(sealed, primary);
  } catch (err) {
    if (!previous) throw err;
    return decryptSecret(sealed, previous);
  }
}

/** Whether remote-source credential encryption is actually usable right now. */
export function encryptionConfigured(): boolean {
  return !!config.remoteSources.encryptionKey;
}

/** Whether MFA secret encryption is actually usable right now. */
export function mfaEncryptionConfigured(): boolean {
  return !!config.mfa.encryptionKey;
}
