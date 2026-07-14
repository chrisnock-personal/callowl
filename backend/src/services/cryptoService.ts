import crypto from "crypto";
import { config } from "../config";

/**
 * Reversible encryption for credentials this platform must send back out
 * (a remote source's API key or OAuth2 client secret) — distinct from
 * authService.ts's API-key hashing, which is verify-only and can't be used
 * here since we need the plaintext back to authenticate against the remote.
 * AES-256-GCM keyed by REMOTE_SOURCE_ENC_KEY (32-byte, base64). Key rotation
 * is out of scope for v1, same posture as ADMIN_API_KEY having none — rotating
 * the key invalidates every previously stored secret; re-enter them after.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size

function encryptionKey(): Buffer {
  if (!config.remoteSources.encryptionKey) {
    throw new Error(
      "REMOTE_SOURCE_ENC_KEY is not configured — required to store or use remote source credentials"
    );
  }
  const key = Buffer.from(config.remoteSources.encryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error("REMOTE_SOURCE_ENC_KEY must decode to exactly 32 bytes (openssl rand -base64 32)");
  }
  return key;
}

/** Returns "iv:authTag:ciphertext", each part base64. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(sealed: string): string {
  const [ivB64, authTagB64, ciphertextB64] = sealed.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted secret — expected iv:authTag:ciphertext");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Whether encryption is actually usable right now — gate creation/use of secrets on this. */
export function encryptionConfigured(): boolean {
  return !!config.remoteSources.encryptionKey;
}
