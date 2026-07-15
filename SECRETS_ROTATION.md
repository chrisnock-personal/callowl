# Secrets rotation runbook

Operator-facing procedures for rotating each of this platform's four secrets. All four support a rotation *window* — old and new both valid at once — so rotating never requires a flag-day cutover where every caller must switch at the exact same instant.

Read [Known limitations](#known-limitations) before you rely on this for anything time-sensitive.

---

## `ADMIN_API_KEY` / `INGEST_API_KEY`

Pure request-time string comparisons (`X-API-Key` header) — no stored data depends on these, so rotation is just changing what's currently accepted.

1. Generate a new value: `openssl rand -base64 32` (any high-entropy string works; this matches the encryption keys' format for consistency, not because it's required here).
2. Set the env var to **both** values, comma-separated, new first: `INGEST_API_KEY=<new>,<old>` (or `ADMIN_API_KEY=...`). Restart the backend. Both values now work.
3. Update whatever sends the key (ingest scripts, `curl` automation, etc.) to the new value.
4. Once confident nothing still sends the old value, set the env var to just `<new>` and restart again — the old value stops working immediately.

**Honest caveat**: the audit log records *that* a request authenticated via API key (`ingest_key`/`admin_key` actor type — see [Audit log](./README.md#audit-log)) but not *which* of the currently-valid values it used. There's no way to positively confirm "the old key is no longer in use" from logs alone — only that requests are still succeeding. If that matters, coordinate the cutover with whoever/whatever holds the old value rather than relying on log evidence it's stopped.

---

## `REMOTE_SOURCE_ENC_KEY` / `MFA_ENC_KEY`

AES-256-GCM keys (`backend/src/services/cryptoService.ts`) that encrypt stored data at rest — remote-source credentials and TOTP MFA secrets respectively. Unlike the two API keys above, stored ciphertext is permanently bound to whatever key sealed it, so rotation is a real migration, not just a config change.

1. Generate a new value: `openssl rand -base64 32`.
2. Set the primary env var to the **new** value, and the matching `_PREVIOUS` var to the **old** one:
   ```bash
   REMOTE_SOURCE_ENC_KEY=<new>
   REMOTE_SOURCE_ENC_KEY_PREVIOUS=<old>
   # or, for MFA:
   MFA_ENC_KEY=<new>
   MFA_ENC_KEY_PREVIOUS=<old>
   ```
3. Restart the backend. At this point: decrypting existing data tries the new key first, falls back to `_PREVIOUS` automatically — nothing breaks. Any *new* write (a new/updated remote source credential, a new MFA enrollment) uses the new key only.
4. Run the rotation script to force every *existing* row onto the new key too:
   ```bash
   podman exec opencdr-backend npm run rotate-encryption-keys
   ```
   This re-encrypts every `remote_sources.auth_config` row and every non-null `users.mfa_secret_encrypted` row. Safe to re-run (idempotent — re-encrypting an already-current-key row just produces new ciphertext for the same plaintext).
5. Verify before removing the old key: trigger a real remote-source poll and confirm it still authenticates correctly; confirm a real user with MFA enabled can still complete login.
6. Remove the `_PREVIOUS` env var entirely and restart once more. The old key is no longer referenced anywhere — safe to discard it.

**If you skip step 4**, rotation never actually finishes — every row stays bound to whichever key originally sealed it, `_PREVIOUS` can never be safely removed, and you've accumulated a second permanent secret to protect instead of retiring the first one.

---

## Known limitations

- **No automatic/scheduled rotation.** Every step above is operator-triggered — generate, edit `.env`, restart. Matches how every other secret in this codebase is already handled (e.g. `ADMIN_API_KEY` itself has no rotation *reminder*, just the mechanism above once you decide to use it).
- **No secrets-manager integration** (Vault, AWS Secrets Manager, etc.) — `.env` on disk is still the only place these live. A real secrets manager is a much bigger infra decision than "support two valid values at once," out of scope here.
- **Session cookies and per-user API keys are a separate story.** Those already have their own independent revocation (delete the session row / `DELETE /auth/api-keys/{id}`) and aren't affected by anything in this document.
- **The rotation script has no dry-run mode.** It re-encrypts and writes back immediately, row by row. Take a backup first if you want a rollback point — see [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md).
