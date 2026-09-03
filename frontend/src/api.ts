const BASE = "/api/cdr/v1";

// Thrown on any non-2xx response; carries the HTTP status so callers (namely
// App.tsx's session handling) can special-case 401 without string-matching.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Fired whenever a request comes back 401 — lets App.tsx drop back to the
// login screen the moment a session expires or is revoked mid-use, without
// every single api.* call site having to check for it individually.
type UnauthorizedListener = () => void;
let onUnauthorized: UnauthorizedListener | null = null;
export function setUnauthorizedHandler(fn: UnauthorizedListener | null): void {
  onUnauthorized = fn;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    credentials: "include",
    ...options,
  });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    const body = await res.json().catch(() => ({}));
    const msg =
      (body && body.error && (body.error.message || body.error)) ||
      `Request failed: ${res.status}`;
    throw new ApiError(typeof msg === "string" ? msg : JSON.stringify(msg), res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// For binary bodies (backup download/restore) — request() assumes JSON both ways.
async function requestRaw(path: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...options });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    const body = await res.json().catch(() => ({}));
    const msg =
      (body && body.error && (body.error.message || body.error)) ||
      `Request failed: ${res.status}`;
    throw new ApiError(typeof msg === "string" ? msg : JSON.stringify(msg), res.status);
  }
  return res;
}

// ─── Spec types (subset used by the UI) ───────────────────────────────────────

export interface DeviceInfo {
  model?: string;
  softwareVersion?: string;
  macAddress?: string;
  ipAddress?: string;
  audioCodec?: string;
  videoCodec?: string;
}

export interface Participant {
  participantId: string;
  role: string;
  extension: string;
  userId?: string;
  displayName?: string;
  deviceId?: string;
  device?: DeviceInfo;
  group?: string;
  recordingConfig?: string;
  joinTime?: string;
  leaveTime?: string;
  slotNumber?: string;
  handsetInfo?: string;
}

export interface CallEvent {
  eventTime: string;
  eventType: string;
  participantId?: string;
  targetParticipantId?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface CallSource {
  huntNumber?: string;
  ivrInfo?: string;
  queueInfo?: string;
  timeInIvrSeconds?: number;
  timeInQueueSeconds?: number;
}

export interface CloudRecordingInfo {
  recordingStatus?: string;
  recordingMethod?: string;
  recordingId?: string;
  mediaName?: string;
  downloadPath?: string;
}

export interface TranscriptionInfo {
  transcriptionStatus?: string;
  transcriptionMethod?: string;
  transcriptId?: string;
  recordingId?: string;
  provider?: string;
  language?: string;
  confidenceScore?: number;
  wordCount?: number;
  redacted?: boolean;
  mediaName?: string;
  downloadPath?: string;
}

export interface QoSInfo {
  mosScore?: number;
  latencyMs?: number;
  jitterMs?: number;
  packetLossPercent?: number;
  packetsTotal?: number;
}

export interface WrapUpInfo {
  wrapUpCode?: string;
  wrapUpNotes?: string;
  wrapUpDurationSeconds?: number;
}

export interface CallRecord {
  callId: string;
  parentCallId?: string;
  relatedCallIds?: string[];
  tenantId?: string;
  sourcePlatformId?: string;
  sourcePlatformType?: string;
  interactionStartTime?: string;
  callStartTime: string;
  callEndTime?: string;
  interactionEndTime?: string;
  lastUpdateTime?: string;
  durationSeconds?: number;
  callState: "ongoing" | "ended" | "missed" | "abandoned";
  callDirection?: "inbound" | "outbound" | "internal" | "unknown";
  callType?: string;
  mediaType: "voice" | "video" | "chat" | "instant_message" | "email" | "unknown";
  callSource?: CallSource;
  wrapUpInfo?: WrapUpInfo;
  participants: Participant[];
  events?: CallEvent[];
  cloudRecording?: CloudRecordingInfo;
  transcription?: TranscriptionInfo;
  qos?: QoSInfo;
  vendorSpecificFields?: Record<string, unknown>;
  _scenario?: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalPages: number;
  totalRecords: number;
}

export interface CallRecordPage {
  data: CallRecord[];
  pagination: Pagination;
}

export interface StatisticsSummary {
  periodStart: string;
  periodEnd: string;
  byComponent: { componentType: string; componentId: string; totalInteractions: number }[];
  byMediaType: { mediaType: string; totalInteractions: number }[];
  voiceBreakdown: {
    maturedAnswered: number;
    unmaturedUnanswered: number;
    abandonedDuringIvr: number;
    abandonedDuringQueue: number;
  };
  averageDurations: {
    avgTimeInIvrSeconds: number;
    avgTimeInQueueSeconds: number;
    avgTimeWithAgentSeconds: number;
    avgTotalInteractionSeconds: number;
  };
}

export interface ListParams {
  startTime: string;
  endTime: string;
  mediaType?: string;
  groups?: string;
  excludeGroups?: string;
  // Platform extensions — not part of the standard's documented GET /calls filters.
  sourcePlatformId?: string;
  participant?: string;
  queue?: string;
  ivr?: string;
  advanced?: string;
  sort?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

// Platform extensions — reporting/insights, not part of the standard's API.
export interface InsightsParams {
  startTime: string;
  endTime: string;
  mediaType?: string;
  groups?: string;
  sourcePlatformId?: string;
}

export interface TopTalker {
  identity: string;
  displayName: string | null;
  isInternal: boolean;
  callCount: number;
  totalDurationSeconds: number;
}

export interface ThroughputPoint {
  bucketStart: string;
  count: number;
}

export interface ThroughputOutcomePoint {
  bucketStart: string;
  answered: number;
  unanswered: number;
}

export interface PlatformBreakdownPoint {
  sourcePlatformId: string | null;
  count: number;
}

export interface HandleTimeTrendPoint {
  bucketStart: string;
  avgSeconds: number;
  callCount: number;
}

export interface AgentHandleTime {
  identity: string;
  displayName: string | null;
  callCount: number;
  avgDurationSeconds: number;
}

export interface QueueWaitTrendPoint {
  bucketStart: string;
  avgSeconds: number;
  callCount: number;
}

export interface QueueWaitBreakdown {
  queueId: string;
  callCount: number;
  avgWaitSeconds: number;
}

export interface WorstMosCall {
  callId: string;
  mosScore: number;
  startTime: string;
  durationSeconds: number | null;
}

export interface IvrTimeTrendPoint {
  bucketStart: string;
  avgSeconds: number;
  callCount: number;
}

export interface IvrBreakdown {
  ivrId: string;
  callCount: number;
  avgTimeSeconds: number;
}

export interface BackupFile {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupLastAttempt {
  at: string;
  status: "ok" | "failed";
}

export interface ArchiverStatus {
  archivedCount: number;
  lastArchivedWal: string | null;
  lastArchivedAt: string | null;
  failedCount: number;
  lastFailedWal: string | null;
  lastFailedAt: string | null;
}

export interface PitrStatus {
  archiving: ArchiverStatus | null;
  baseBackupIntervalHours: number;
  lastBaseBackupAttempt: BackupLastAttempt | null;
}

export interface OffsiteStatus {
  configured: boolean;
  intervalHours: number;
  lastAttempt: BackupLastAttempt | null;
}

export interface BackupStatus {
  data: BackupFile[];
  retentionDays: number;
  intervalHours: number;
  configured: boolean;
  lastAttempt: BackupLastAttempt | null;
  pitr: PitrStatus;
  offsite: OffsiteStatus;
}

export interface PublicStatusComponent {
  name: string;
  status: "operational" | "unavailable";
}

export interface PublicStatus {
  status: "operational" | "unavailable";
  timestamp: string;
  apiVersion: string;
  components: PublicStatusComponent[];
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

export type ActorType = "user" | "ingest_key" | "admin_key" | "anonymous";

export interface AuditLogEntry {
  id: number;
  occurredAt: string;
  actorType: ActorType;
  actorId: string | null;
  method: string;
  path: string;
  statusCode: number;
  recordCount: number | null;
  params: Record<string, unknown> | null;
  ipAddress: string | null;
}

export interface AuditLogParams {
  actorId?: string;
  method?: string;
  pathPrefix?: string;
  startTime?: string;
  endTime?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditLogPage {
  data: AuditLogEntry[];
  pagination: Pagination;
}

export type UserRole = "admin" | "viewer";

export interface AuthUser {
  username: string;
  role: UserRole;
  allowedGroups: string[] | null;
  allowedSourcePlatformIds: string[] | null;
  mfaEnabled: boolean;
}

// POST /auth/login returns this instead of a full AuthUser when the account
// has MFA enabled — pendingToken is submitted along with a code to
// POST /auth/login/mfa to actually complete the login.
export interface MfaRequiredResponse {
  mfaRequired: true;
  pendingToken: string;
}

export type LoginResult = AuthUser | MfaRequiredResponse;

export interface MfaEnrollment {
  secret: string;
  otpauthUri: string;
}

export interface ManagedUser extends AuthUser {
  id: number;
  createdAt: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
  allowedGroups?: string[] | null;
  allowedSourcePlatformIds?: string[] | null;
}

export interface UpdateUserInput {
  password?: string;
  role?: UserRole;
  allowedGroups?: string[] | null;
  allowedSourcePlatformIds?: string[] | null;
}

export interface ApiKeyMeta {
  id: number;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// Only what POST /auth/api-keys returns — the raw key is never retrievable again.
export interface CreatedApiKey extends ApiKeyMeta {
  key: string;
}

export type RemoteSourceAuthType = "api_key" | "oauth2_client_credentials" | "custom";
export type RemotePollStatus =
  | "ok"
  | "auth_error"
  | "fetch_error"
  | "validation_rejects"
  | "skipped_locked";

export interface RemoteSourceMeta {
  id: number;
  name: string;
  baseUrl: string;
  authType: RemoteSourceAuthType;
  enabled: boolean;
  pollIntervalMinutes: number;
  backfillFrom: string;
  watermark: string | null;
  lastPolledAt: string | null;
  lastPollStatus: RemotePollStatus | null;
  lastPollError: string | null;
  rejectCount: number;
  createdAt: string;
  updatedAt: string;
}

// Write-only — never returned by the API, only ever sent. The admin already
// knows the secret (typed it in from the remote platform's own admin panel),
// so unlike a generated API key there's no "only chance to see it" to preserve.
export type RemoteSourceAuthInput =
  | { authType: "api_key"; apiKey: string; headerName?: string }
  | {
      authType: "oauth2_client_credentials";
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
    }
  | { authType: "custom"; scriptBody: string; env: Record<string, string> };

export interface CreateRemoteSourceInput {
  name: string;
  baseUrl: string;
  pollIntervalMinutes: number;
  backfillFrom: string;
  auth: RemoteSourceAuthInput;
}

export interface UpdateRemoteSourceInput {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  pollIntervalMinutes?: number;
  /** Omitted entirely = credential unchanged; full replacement when provided. */
  auth?: RemoteSourceAuthInput;
}

export interface PollSummary {
  sourceId: number;
  pagesRead: number;
  accepted: number;
  rejected: number;
  status: RemotePollStatus;
  watermark: string | null;
  error?: string;
}

export interface RemoteSourceReject {
  id: number;
  remoteSourceId: number;
  occurredAt: string;
  callId: string | null;
  validationError: string;
  recordRaw: unknown;
}

export interface RemoteSourceRejectParams {
  page?: number;
  pageSize?: number;
}

export interface RemoteSourceRejectPage {
  data: RemoteSourceReject[];
  pagination: Pagination;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  return p.toString();
}

export const api = {
  listCalls: (params: ListParams) =>
    request<CallRecordPage>(`/calls?${qs(params)}`),

  getCall: (callId: string) =>
    request<CallRecord>(`/calls/${encodeURIComponent(callId)}`),

  statistics: (startTime: string, endTime: string) =>
    request<StatisticsSummary>(
      `/statistics/summary?${qs({ startTime, endTime })}`
    ),

  health: () =>
    request<{ status: string; apiVersion: string; platformVersion?: string }>(
      `/health`
    ),

  ingest: (body: unknown, apiKey?: string) =>
    request<{ accepted: number; created: number; updated: number }>(
      `/calls/ingest`,
      {
        method: "POST",
        headers: apiKey ? { "X-API-Key": apiKey } : {},
        body: JSON.stringify(body),
      }
    ),

  topTalkers: (
    params: InsightsParams & { limit?: number; scope?: "internal" | "external" | "all" }
  ) => request<{ data: TopTalker[] }>(`/statistics/top-talkers?${qs(params)}`),

  throughput: (params: InsightsParams & { bucket: "hour" | "day" }) =>
    request<{ data: ThroughputPoint[] }>(`/statistics/throughput?${qs(params)}`),

  throughputByOutcome: (params: InsightsParams & { bucket: "hour" | "day" }) =>
    request<{ data: ThroughputOutcomePoint[] }>(
      `/statistics/throughput/by-outcome?${qs(params)}`
    ),

  byPlatform: (params: InsightsParams) =>
    request<{ data: PlatformBreakdownPoint[] }>(`/statistics/by-platform?${qs(params)}`),

  handleTimeTrend: (params: InsightsParams & { bucket: "hour" | "day" }) =>
    request<{ data: HandleTimeTrendPoint[] }>(`/statistics/handle-time?${qs(params)}`),

  agentHandleTime: (params: InsightsParams & { limit?: number }) =>
    request<{ data: AgentHandleTime[] }>(`/statistics/handle-time/by-agent?${qs(params)}`),

  queueWaitTrend: (params: InsightsParams & { bucket: "hour" | "day" }) =>
    request<{ data: QueueWaitTrendPoint[] }>(`/statistics/queue-wait?${qs(params)}`),

  queueWaitBreakdown: (params: InsightsParams & { limit?: number }) =>
    request<{ data: QueueWaitBreakdown[] }>(`/statistics/queue-wait/by-queue?${qs(params)}`),

  worstMosCalls: (params: InsightsParams & { limit?: number }) =>
    request<{ data: WorstMosCall[] }>(`/statistics/worst-mos?${qs(params)}`),

  ivrTimeTrend: (params: InsightsParams & { bucket: "hour" | "day" }) =>
    request<{ data: IvrTimeTrendPoint[] }>(`/statistics/ivr-time?${qs(params)}`),

  ivrTimeByIvr: (params: InsightsParams & { limit?: number }) =>
    request<{ data: IvrBreakdown[] }>(`/statistics/ivr-time/by-ivr?${qs(params)}`),

  backupStatus: () => request<BackupStatus>(`/admin/backups`),

  triggerBackup: async (apiKey?: string): Promise<BackupFile> => {
    const res = await requestRaw(`/admin/backups`, {
      method: "POST",
      headers: apiKey ? { "X-API-Key": apiKey } : {},
    });
    return res.json();
  },

  downloadBackupBlob: async (filename: string, apiKey?: string): Promise<Blob> => {
    const res = await requestRaw(`/admin/backups/${encodeURIComponent(filename)}/download`, {
      headers: apiKey ? { "X-API-Key": apiKey } : {},
    });
    return res.blob();
  },

  restoreBackup: async (
    file: File,
    apiKey?: string
  ): Promise<{ ok: boolean; message: string }> => {
    const res = await requestRaw(`/admin/backups/restore`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
      },
      body: file,
    });
    return res.json();
  },

  statusPageConfig: () => request<{ enabled: boolean }>(`/admin/status-page`),

  setStatusPageEnabled: (enabled: boolean) =>
    request<{ enabled: boolean }>(`/admin/status-page`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),

  tlsStatus: () => request<CertInfo | null>(`/admin/tls`),

  replaceTls: (cert: string, key: string, apiKey?: string) =>
    request<CertInfo>(`/admin/tls`, {
      method: "POST",
      headers: apiKey ? { "X-API-Key": apiKey } : {},
      body: JSON.stringify({ cert, key }),
    }),

  // Unauthenticated on purpose — powers frontend/src/StatusPage.tsx, the
  // public page rendered for anyone visiting /status. 404s (surfaced as a
  // thrown ApiError, same as everywhere else) when the admin hasn't turned
  // it on — see GET /status.
  publicStatus: () => request<PublicStatus>(`/status`),

  login: (username: string, password: string) =>
    request<LoginResult>(`/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  loginMfa: (pendingToken: string, code: string) =>
    request<AuthUser>(`/auth/login/mfa`, {
      method: "POST",
      body: JSON.stringify({ pendingToken, code }),
    }),

  logout: () => request<{ ok: boolean }>(`/auth/logout`, { method: "POST" }),

  me: () => request<AuthUser>(`/auth/me`),

  mfa: {
    setup: () => request<MfaEnrollment>(`/auth/mfa/setup`, { method: "POST" }),

    confirm: (code: string) =>
      request<{ recoveryCodes: string[] }>(`/auth/mfa/confirm`, {
        method: "POST",
        body: JSON.stringify({ code }),
      }),

    disable: (password: string, code: string) =>
      request<{ ok: boolean }>(`/auth/mfa/disable`, {
        method: "POST",
        body: JSON.stringify({ password, code }),
      }),
  },

  users: {
    list: () => request<{ data: ManagedUser[] }>(`/admin/users`),

    create: (input: CreateUserInput) =>
      request<ManagedUser>(`/admin/users`, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    update: (id: number, input: UpdateUserInput) =>
      request<ManagedUser>(`/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),

    remove: (id: number) =>
      request<void>(`/admin/users/${id}`, { method: "DELETE" }),

    resetMfa: (id: number) =>
      request<{ ok: boolean }>(`/admin/users/${id}/mfa/reset`, { method: "POST" }),
  },

  apiKeys: {
    list: () => request<{ data: ApiKeyMeta[] }>(`/auth/api-keys`),

    create: (name: string) =>
      request<CreatedApiKey>(`/auth/api-keys`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),

    remove: (id: number) =>
      request<void>(`/auth/api-keys/${id}`, { method: "DELETE" }),
  },

  auditLog: {
    list: (params: AuditLogParams) =>
      request<AuditLogPage>(`/admin/audit-log?${qs(params)}`),
  },

  remoteSources: {
    list: () => request<{ data: RemoteSourceMeta[] }>(`/admin/remote-sources`),

    create: (input: CreateRemoteSourceInput) =>
      request<RemoteSourceMeta>(`/admin/remote-sources`, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    update: (id: number, input: UpdateRemoteSourceInput) =>
      request<RemoteSourceMeta>(`/admin/remote-sources/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),

    remove: (id: number) =>
      request<void>(`/admin/remote-sources/${id}`, { method: "DELETE" }),

    pollNow: (id: number) =>
      request<PollSummary>(`/admin/remote-sources/${id}/poll`, { method: "POST" }),

    rejects: (id: number, params: RemoteSourceRejectParams) =>
      request<RemoteSourceRejectPage>(`/admin/remote-sources/${id}/rejects?${qs(params)}`),
  },
};
