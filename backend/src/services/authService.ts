import bcrypt from "bcryptjs";
import crypto from "crypto";
import { query, queryOne } from "../db/pool";

export type UserRole = "admin" | "viewer";

export interface User {
  id: number;
  username: string;
  role: UserRole;
  allowedGroups: string[] | null;
  allowedSourcePlatformIds: string[] | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  allowed_groups: string[] | null;
  allowed_source_platform_ids: string[] | null;
  created_at: string;
}

const USER_COLUMNS = `id::text, username, password_hash, role, allowed_groups, allowed_source_platform_ids, created_at`;

function toUser(row: UserRow): User {
  return {
    id: parseInt(row.id, 10),
    username: row.username,
    role: row.role as UserRole,
    allowedGroups: row.allowed_groups,
    allowedSourcePlatformIds: row.allowed_source_platform_ids,
    createdAt: row.created_at,
  };
}

// 7 days — long enough that a dashboard user browsing a home-lab tool isn't
// re-prompted constantly, short enough that a stale session doesn't linger forever.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

export async function countUsers(): Promise<number> {
  const row = await queryOne<{ n: string }>("SELECT COUNT(*)::text AS n FROM users");
  return parseInt(row?.n ?? "0", 10);
}

export async function createUser(input: {
  username: string;
  password: string;
  role: UserRole;
  allowedGroups?: string[] | null;
  allowedSourcePlatformIds?: string[] | null;
}): Promise<User> {
  const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const row = await queryOne<UserRow>(
    `INSERT INTO users (username, password_hash, role, allowed_groups, allowed_source_platform_ids)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${USER_COLUMNS}`,
    [
      input.username,
      hash,
      input.role,
      input.allowedGroups ?? null,
      input.allowedSourcePlatformIds ?? null,
    ]
  );
  return toUser(row!);
}

export async function listUsers(): Promise<User[]> {
  const rows = await query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY username ASC`
  );
  return rows.map(toUser);
}

export async function getUserById(id: number): Promise<User | null> {
  const row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [id]
  );
  return row ? toUser(row) : null;
}

export interface UserPatch {
  role?: UserRole;
  allowedGroups?: string[] | null;
  allowedSourcePlatformIds?: string[] | null;
  password?: string;
}

export async function updateUser(id: number, patch: UserPatch): Promise<User | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.role !== undefined) {
    params.push(patch.role);
    sets.push(`role = $${params.length}`);
  }
  if (patch.allowedGroups !== undefined) {
    params.push(patch.allowedGroups);
    sets.push(`allowed_groups = $${params.length}`);
  }
  if (patch.allowedSourcePlatformIds !== undefined) {
    params.push(patch.allowedSourcePlatformIds);
    sets.push(`allowed_source_platform_ids = $${params.length}`);
  }
  if (patch.password !== undefined) {
    const hash = await bcrypt.hash(patch.password, BCRYPT_ROUNDS);
    params.push(hash);
    sets.push(`password_hash = $${params.length}`);
  }
  if (sets.length === 0) return getUserById(id);

  sets.push("updated_at = now()");
  params.push(id);
  const row = await queryOne<UserRow>(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${USER_COLUMNS}`,
    params
  );
  return row ? toUser(row) : null;
}

export async function deleteUser(id: number): Promise<boolean> {
  const rows = await query<{ id: string }>("DELETE FROM users WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}

/** Verifies credentials for POST /auth/login. Returns the user on success, null otherwise. */
export async function verifyPassword(username: string, password: string): Promise<User | null> {
  const row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE username = $1`,
    [username]
  );
  if (!row) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  return ok ? toUser(row) : null;
}

export async function createSession(userId: number): Promise<{ id: string; expiresAt: Date }> {
  const id = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [
    id,
    userId,
    expiresAt.toISOString(),
  ]);
  return { id, expiresAt };
}

export async function destroySession(sessionId: string): Promise<void> {
  await query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

/** Looks up the user for a session cookie, or null if missing/expired. */
export async function getUserBySession(sessionId: string): Promise<User | null> {
  const row = await queryOne<UserRow>(
    `SELECT u.id::text, u.username, u.password_hash, u.role,
            u.allowed_groups, u.allowed_source_platform_ids, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId]
  );
  return row ? toUser(row) : null;
}

// ─── API keys ─────────────────────────────────────────────────────────────
// Named, revocable alternative to the session cookie: a key acts as the user
// who created it (same role, same scope), enforced by the same scopeFilters
// path — see middleware/auth.ts. Keys are high-entropy random tokens rather
// than user-chosen secrets, so a fast indexed SHA-256 hash is the right tool,
// unlike bcrypt for passwords.

export interface ApiKeyMeta {
  id: number;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

// "ocdr_" + 8 chars — enough to recognize a key in a list, not the secret itself.
const API_KEY_PREFIX_LEN = 13;

function toApiKeyMeta(row: ApiKeyRow): ApiKeyMeta {
  return {
    id: parseInt(row.id, 10),
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/** Creates a key for a user and returns it with the raw value — the only time it's ever visible. */
export async function createApiKey(
  userId: number,
  name: string
): Promise<ApiKeyMeta & { key: string }> {
  const rawKey = `ocdr_${crypto.randomBytes(24).toString("base64url")}`;
  const row = await queryOne<ApiKeyRow>(
    `INSERT INTO api_keys (user_id, name, key_hash, key_prefix)
     VALUES ($1, $2, $3, $4)
     RETURNING id::text, name, key_prefix, created_at, last_used_at`,
    [userId, name, hashApiKey(rawKey), rawKey.slice(0, API_KEY_PREFIX_LEN)]
  );
  return { ...toApiKeyMeta(row!), key: rawKey };
}

export async function listApiKeys(userId: number): Promise<ApiKeyMeta[]> {
  const rows = await query<ApiKeyRow>(
    `SELECT id::text, name, key_prefix, created_at, last_used_at
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map(toApiKeyMeta);
}

/** Deletes a key, scoped to its owner — a user can only ever revoke their own. */
export async function deleteApiKey(userId: number, id: number): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  return rows.length > 0;
}

/** Looks up the user for an X-API-Key header value, or null if invalid/revoked. */
export async function getUserByApiKey(rawKey: string): Promise<User | null> {
  const row = await queryOne<UserRow & { key_id: string }>(
    `SELECT u.id::text, u.username, u.password_hash, u.role,
            u.allowed_groups, u.allowed_source_platform_ids, u.created_at,
            k.id::text AS key_id
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1`,
    [hashApiKey(rawKey)]
  );
  if (!row) return null;
  // Best-effort — a slow/failed timestamp update shouldn't block the request itself.
  query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.key_id]).catch(() => {});
  return toUser(row);
}
