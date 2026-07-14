import type { RemoteSourceAuth } from "./remoteSourceService";

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

// In-process only, keyed by remote_sources.id — a restart just costs one
// extra token fetch, same throwaway-cache posture as nothing else in this
// codebase persists derived auth state either.
const tokenCache = new Map<number, CachedToken>();

const REFRESH_MARGIN_MS = 60_000;

async function fetchClientCredentialsToken(
  auth: Extract<RemoteSourceAuth, { authType: "oauth2_client_credentials" }>
): Promise<CachedToken> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
  });
  if (auth.scope) body.set("scope", auth.scope);

  const res = await fetch(auth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Token request to ${auth.tokenUrl} failed: ${res.status} ${detail}`.trim());
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error(`Token response from ${auth.tokenUrl} had no access_token`);
  }
  const ttlMs = (data.expires_in ?? 3600) * 1000;
  return { token: data.access_token, expiresAt: Date.now() + ttlMs };
}

/**
 * Builds the header(s) needed to authenticate against a remote source's own
 * GET /calls. api_key is synchronous and uncached; oauth2_client_credentials
 * fetches a token from tokenUrl and caches it in-process, refreshed once
 * within REFRESH_MARGIN_MS of expiry. Only called for the two HTTP-fetch
 * source types — 'custom' sources run a script instead (remoteScriptRunner.ts)
 * and never reach this function, hence the narrowed parameter type below.
 */
export async function getAuthHeader(
  sourceId: number,
  auth: Exclude<RemoteSourceAuth, { authType: "custom" }>
): Promise<Record<string, string>> {
  if (auth.authType === "api_key") {
    return { [auth.headerName]: auth.apiKey };
  }

  const cached = tokenCache.get(sourceId);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return { Authorization: `Bearer ${cached.token}` };
  }
  const fresh = await fetchClientCredentialsToken(auth);
  tokenCache.set(sourceId, fresh);
  return { Authorization: `Bearer ${fresh.token}` };
}
