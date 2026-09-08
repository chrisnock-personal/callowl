# Secrets rotation runbook

Operator procedures for rotating this platform's four secrets. All four support a rotation *window* (old and new both valid at once), so rotating never needs a flag-day cutover.

Read [Known limitations](#known-limitations) before you rely on this for anything time-sensitive.

---

## `ADMIN_API_KEY` / `INGEST_API_KEY`

Pure request-time string comparisons (`X-API-Key` header) — no stored data depends on these, so rotation is just changing what's accepted.

1. Generate a new value: `openssl rand -base64 32` (any high-entropy string works).
2. Set the env var to **both** values, comma-separated, new first: `INGEST_API_KEY=<new>,<old>`. Restart the backend — both now work.
3. Update whatever sends the key (ingest scripts, automation) to the new value.
4. Once confident nothing sends the old value, set the env var to just `<new>` and restart — old value stops working immediately.

**Caveat**: the audit log records *that* a request authenticated via API key, not *which* valid value it used — you can't confirm "old key unused" from logs alone. Coordinate the cutover directly if that matters.

---

## `REMOTE_SOURCE_ENC_KEY` / `MFA_ENC_KEY`

AES-256-GCM keys (`backend/src/services/cryptoService.ts`) encrypting data at rest — remote-source credentials and TOTP MFA secrets. Unlike the API keys above, stored ciphertext is bound to whatever key sealed it, so rotation is a real migration.

1. Generate a new value: `openssl rand -base64 32`.
2. Set the primary var to the **new** value, `_PREVIOUS` to the **old**:
   ```bash
   REMOTE_SOURCE_ENC_KEY=<new>
   REMOTE_SOURCE_ENC_KEY_PREVIOUS=<old>
   # or, for MFA:
   MFA_ENC_KEY=<new>
   MFA_ENC_KEY_PREVIOUS=<old>
   ```
3. Restart the backend — decryption tries the new key, falls back to `_PREVIOUS`; new writes use the new key only.
4. Force every existing row onto the new key:
   ```bash
   podman exec callowl-backend npm run rotate-encryption-keys
   ```
   Re-encrypts every `remote_sources.auth_config` row and non-null `users.mfa_secret_encrypted` row. Idempotent, safe to re-run.
5. Verify before removing the old key: trigger a real remote-source poll, confirm a real MFA user can still log in.
6. Remove `_PREVIOUS` and restart once more — the old key is no longer referenced anywhere.

**Skip step 4 and rotation never finishes** — rows stay bound to whichever key sealed them, `_PREVIOUS` can never be safely removed, and you've accumulated a second permanent secret instead of retiring the first.

---

## Known limitations

- **No automatic/scheduled rotation** — every step above is operator-triggered (generate, edit `.env`, restart).
- **No secrets-manager integration** (Vault, AWS Secrets Manager, etc.) — `.env` on disk is the only place these live.
- **Session cookies and per-user API keys are separate** — already independently revocable (delete the session row / `DELETE /auth/api-keys/{id}`), unaffected by anything here.
- **The rotation script has no dry-run mode** — re-encrypts and writes back immediately, row by row. Take a backup first if you want a rollback point — see [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md).
