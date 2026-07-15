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

/** Whether remote-source credential encryption is actually usable right now. */
export function encryptionConfigured(): boolean {
  return !!config.remoteSources.encryptionKey;
}

/** Whether MFA secret encryption is actually usable right now. */
export function mfaEncryptionConfigured(): boolean {
  return !!config.mfa.encryptionKey;
}
