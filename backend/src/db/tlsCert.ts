import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "../config";
import { createError } from "../middleware/errorHandler";

// Reads/replaces the TLS certificate the `frontend` container's nginx
// serves (frontend/nginx.conf, frontend/docker-entrypoint.sh's self-signed
// default). Unlike a single-container deploy, this backend container has no
// nginx of its own to `nginx -t`/reload against — it shares the `certs`
// volume (mounted here at TLS_CERTS_DIR, in `frontend` at /etc/nginx/certs)
// and can validate the cert/key pair itself, but the actual swap-in,
// `nginx -t` check, reload, and rollback-on-failure has to happen on the
// nginx side. frontend/cert-watcher.sh owns that half: it polls for
// pending.crt/pending.key, and reports back via .cert-reload-status — same
// "<UTC timestamp> ok|failed" marker-file convention as .last-attempt/
// .offsite-last-attempt, extended with an optional reason line since a
// rejected cert needs one to be actionable.

function certsDir(): string {
  const dir = config.tls.certsDir;
  if (!dir) {
    throw createError(
      "TLS_CERTS_DIR is not configured — the certs volume isn't mounted on this container",
      501
    );
  }
  return dir;
}

export interface CertInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprintSha256: string;
  isSelfSigned: boolean;
  isExpired: boolean;
}

function describeCert(x509: crypto.X509Certificate): CertInfo {
  return {
    subject: x509.subject,
    issuer: x509.issuer,
    validFrom: x509.validFrom,
    validTo: x509.validTo,
    fingerprintSha256: x509.fingerprint256,
    // A self-signed cert's issuer is itself — the generated default always
    // has subject === issuer; a real PKI-issued one won't.
    isSelfSigned: x509.subject === x509.issuer,
    isExpired: new Date(x509.validTo) < new Date(),
  };
}

/** Reads whatever cert nginx is currently serving. Null if none exists yet
 * (frontend container hasn't generated its self-signed default, or the
 * volume isn't shared correctly). */
export function getCurrentCertInfo(): CertInfo | null {
  const certPath = path.join(certsDir(), "server.crt");
  if (!fs.existsSync(certPath)) return null;
  return describeCert(new crypto.X509Certificate(fs.readFileSync(certPath, "utf8")));
}

/**
 * Validates a cert+key pair actually match and the cert isn't already
 * expired, then stages them as pending.crt/pending.key for
 * frontend/cert-watcher.sh to pick up. Throws (400) on any validation
 * failure before ever writing to the shared volume. Returns immediately
 * once staged — call waitForReload() to learn the actual outcome.
 */
export function stageCertForReload(certPem: string, keyPem: string): CertInfo {
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(certPem);
  } catch {
    throw createError("Invalid certificate — could not parse as PEM", 400);
  }

  let privKey: crypto.KeyObject;
  try {
    privKey = crypto.createPrivateKey(keyPem);
  } catch {
    throw createError("Invalid private key — could not parse as PEM", 400);
  }

  if (!crypto.createPublicKey(privKey).equals(x509.publicKey)) {
    throw createError("Certificate and private key do not match", 400);
  }
  if (new Date(x509.validTo) < new Date()) {
    throw createError(`Certificate already expired on ${x509.validTo}`, 400);
  }

  const dir = certsDir();
  // Cleared before staging so waitForReload() below can tell a fresh result
  // apart from a leftover one from some earlier attempt.
  const statusFile = path.join(dir, ".cert-reload-status");
  if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile);

  fs.writeFileSync(path.join(dir, "pending.crt"), certPem, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, "pending.key"), keyPem, { mode: 0o600 });

  return describeCert(x509);
}

export interface ReloadOutcome {
  status: "ok" | "failed" | "timeout";
  at: string | null;
  reason: string | null;
}

function readReloadStatus(dir: string): { at: string; status: "ok" | "failed"; reason: string | null } | null {
  const file = path.join(dir, ".cert-reload-status");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const first = (lines[0] ?? "").trim();
  const spaceIdx = first.indexOf(" ");
  if (spaceIdx === -1) return null;
  const at = first.slice(0, spaceIdx);
  const status = first.slice(spaceIdx + 1);
  if (status !== "ok" && status !== "failed") return null;
  return { at, status, reason: status === "failed" ? lines.slice(1).join(" ").trim() || null : null };
}

/** Polls .cert-reload-status (written by frontend/cert-watcher.sh, which
 * checks every 2s) until it reflects the outcome of the pending cert just
 * staged, or times out. */
export async function waitForReload(timeoutMs = 12000, pollMs = 500): Promise<ReloadOutcome> {
  const dir = certsDir();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = readReloadStatus(dir);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { status: "timeout", at: null, reason: null };
}
