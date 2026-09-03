import crypto from "crypto";
import { listUsers, createUser, User, UserRole } from "./authService";
import { createApiKey, listApiKeys } from "./authService";
import { listRemoteSources, RemoteSourceAuthType } from "./remoteSourceService";

// Portable JSON bundle for standing up a second environment or migrating
// hosts without manually re-creating users/API keys/remote sources one at a
// time. Deliberately never includes a secret an import can't safely
// regenerate on its own — same "secrets are write-only, never round-tripped
// back to the client" posture routes/admin.ts's remote-source routes already
// commit to:
//   - user passwords: never exported (only a bcrypt hash exists to export
//     anyway, and it's not portable — a different bcrypt cost or a rotation
//     policy on the target could make it meaningless even if it were).
//     Import creates a fresh random password per user instead, revealed once
//     in the response, the same "generated — save it now" pattern
//     db/seedAdmin.ts already uses for the bootstrap admin.
//   - API key values: impossible to export at all — only a one-way hash is
//     ever stored (api_keys migration's own comment: "the raw key is only
//     ever returned once, at creation time"). Import creates fresh keys
//     instead, same reveal-once treatment.
//   - remote source credentials: encrypted at rest specifically so they're
//     never handled in the clear again — an export that decrypted and wrote
//     them to a JSON file would undo that. Remote source *definitions*
//     (name, base URL, auth type, poll interval, backfill window) export and
//     are surfaced back on import, but re-adding the actual credential is a
//     manual step via the existing Remote sources panel, same as it already
//     is when rotating one.

export interface ConfigExportUser {
  username: string;
  role: UserRole;
  allowedGroups: string[] | null;
  allowedSourcePlatformIds: string[] | null;
}

export interface ConfigExportApiKey {
  username: string;
  name: string;
}

export interface ConfigExportRemoteSource {
  name: string;
  baseUrl: string;
  authType: RemoteSourceAuthType;
  pollIntervalMinutes: number;
  backfillFrom: string;
  enabled: boolean;
}

export interface ConfigBundle {
  exportedAt: string;
  users: ConfigExportUser[];
  apiKeys: ConfigExportApiKey[];
  remoteSources: ConfigExportRemoteSource[];
}

export async function exportConfig(): Promise<ConfigBundle> {
  const [users, remoteSources] = await Promise.all([listUsers(), listRemoteSources()]);

  const apiKeys: ConfigExportApiKey[] = [];
  for (const u of users) {
    const keys = await listApiKeys(u.id);
    for (const k of keys) apiKeys.push({ username: u.username, name: k.name });
  }

  return {
    exportedAt: new Date().toISOString(),
    users: users.map((u) => ({
      username: u.username,
      role: u.role,
      allowedGroups: u.allowedGroups,
      allowedSourcePlatformIds: u.allowedSourcePlatformIds,
    })),
    apiKeys,
    remoteSources: remoteSources.map((s) => ({
      name: s.name,
      baseUrl: s.baseUrl,
      authType: s.authType,
      pollIntervalMinutes: s.pollIntervalMinutes,
      backfillFrom: s.backfillFrom,
      enabled: s.enabled,
    })),
  };
}

export interface ImportResult {
  users: {
    created: { username: string; password: string }[];
    skipped: { username: string; reason: string }[];
  };
  apiKeys: {
    created: { username: string; name: string; key: string }[];
    skipped: { username: string; name: string; reason: string }[];
  };
  // Never auto-created — see the module comment above. Passed straight
  // through so the UI can show "recreate these with a real credential."
  remoteSources: ConfigExportRemoteSource[];
}

export async function importConfig(bundle: Partial<ConfigBundle>): Promise<ImportResult> {
  const existing = await listUsers();
  const byUsername = new Map<string, User>(existing.map((u) => [u.username, u]));

  const result: ImportResult = {
    users: { created: [], skipped: [] },
    apiKeys: { created: [], skipped: [] },
    remoteSources: bundle.remoteSources ?? [],
  };

  for (const u of bundle.users ?? []) {
    if (byUsername.has(u.username)) {
      result.users.skipped.push({ username: u.username, reason: "username already exists" });
      continue;
    }
    const password = crypto.randomBytes(12).toString("base64url");
    const created = await createUser({
      username: u.username,
      password,
      role: u.role,
      allowedGroups: u.allowedGroups,
      allowedSourcePlatformIds: u.allowedSourcePlatformIds,
    });
    byUsername.set(created.username, created);
    result.users.created.push({ username: created.username, password });
  }

  for (const k of bundle.apiKeys ?? []) {
    const owner = byUsername.get(k.username);
    if (!owner) {
      result.apiKeys.skipped.push({ username: k.username, name: k.name, reason: "owner not found" });
      continue;
    }
    const ownerKeys = await listApiKeys(owner.id);
    if (ownerKeys.some((existingKey) => existingKey.name === k.name)) {
      result.apiKeys.skipped.push({ username: k.username, name: k.name, reason: "already exists" });
      continue;
    }
    const created = await createApiKey(owner.id, k.name);
    result.apiKeys.created.push({ username: owner.username, name: created.name, key: created.key });
  }

  return result;
}
