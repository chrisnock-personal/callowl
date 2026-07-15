import React, { useState, useEffect, useCallback } from "react";
import {
  api,
  setUnauthorizedHandler,
  CallRecord,
  CallEvent,
  Participant,
  Pagination,
  StatisticsSummary,
  TopTalker,
  ThroughputPoint,
  ThroughputOutcomePoint,
  PlatformBreakdownPoint,
  HandleTimeTrendPoint,
  AgentHandleTime,
  QueueWaitTrendPoint,
  QueueWaitBreakdown,
  WorstMosCall,
  IvrTimeTrendPoint,
  IvrBreakdown,
  BackupStatus,
  AuthUser,
  MfaEnrollment,
  ManagedUser,
  ApiKeyMeta,
  AuditLogEntry,
  RemoteSourceMeta,
  RemoteSourceAuthType,
  RemoteSourceAuthInput,
  RemotePollStatus,
  RemoteSourceReject,
} from "./api";

// ─── Palette: "signal & routing" ──────────────────────────────────────────────
// Cool paper, ink text, a signal-blue primary, and call-state colours drawn from
// switchboard signalling rather than a generic dashboard green.
const C = {
  bg: "#EDF0F4",
  surface: "#FFFFFF",
  surfaceAlt: "#F5F7FA",
  surfaceDeep: "#E7ECF2",
  border: "#DCE2EA",
  borderStrong: "#C4CCD6",
  ink: "#0F1620",
  textMid: "#46505E",
  textMuted: "#8794A3",
  accent: "#1D5FD6",
  accentDeep: "#163F8F",
  accentSoft: "#E4EDFC",
  teal: "#0E9C8E",
  tealSoft: "#DEF3F0",
  amber: "#B9750A",
  amberSoft: "#FBF0DA",
  rose: "#C63A55",
  roseSoft: "#FBE6EB",
  violet: "#6B4BD1",
  violetSoft: "#ECE7FB",
};

const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace";
const SANS =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", {
        dateStyle: "short",
        timeStyle: "medium",
      })
    : "—";

const fmtTimeOnly = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";

function fmtDur(seconds?: number): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function stateStyle(state: CallRecord["callState"]) {
  switch (state) {
    case "ended":
      return { fg: C.teal, bg: C.tealSoft, label: "Ended" };
    case "ongoing":
      return { fg: C.amber, bg: C.amberSoft, label: "Ongoing" };
    case "missed":
      return { fg: C.rose, bg: C.roseSoft, label: "Missed" };
    case "abandoned":
      return { fg: C.rose, bg: C.roseSoft, label: "Abandoned" };
    default:
      return { fg: C.textMid, bg: C.surfaceDeep, label: state };
  }
}

const mediaGlyph: Record<string, string> = {
  voice: "◍",
  video: "▤",
  chat: "❝",
  instant_message: "✦",
  email: "✉",
  unknown: "·",
};

const directionGlyph: Record<string, string> = {
  inbound: "↘",
  outbound: "↗",
  internal: "⇄",
  unknown: "·",
};

// ANI/DNIS only cleanly exist for a plain two-party call. For anything else
// (conferences, transfer legs, IVR/queue abandons) the "caller"/"callee" pair
// is just the primary leg; every other participant is surfaced as an
// expandable sub-row in the records table rather than forcing a column that
// can't represent them.
function computeAniDnis(
  r: CallRecord
): { ani: string; dnis: string; extraParticipants: Participant[] } {
  const caller = r.participants.find((p) => p.role === "caller");
  const callee = r.participants.find((p) => p.role === "callee");
  const shown = new Set([caller?.participantId, callee?.participantId].filter(Boolean));
  return {
    ani: caller?.extension ?? "—",
    dnis: callee?.extension ?? r.callSource?.huntNumber ?? "—",
    extraParticipants: r.participants.filter((p) => !shown.has(p.participantId)),
  };
}

// Event families → colour + label, so the timeline encodes what kind of thing
// happened, not just that something did.
function eventStyle(type: string): { color: string; soft: string; label: string } {
  const label = type.replace(/_/g, " ");
  if (type === "ringing" || type === "connected" || type === "resume")
    return { color: C.teal, soft: C.tealSoft, label };
  if (type === "disconnected" || type === "missed")
    return { color: C.rose, soft: C.roseSoft, label };
  if (type === "hold" || type === "park")
    return { color: C.violet, soft: C.violetSoft, label };
  if (type.startsWith("transfer") || type === "conference_created")
    return { color: C.accent, soft: C.accentSoft, label };
  if (
    type.startsWith("participant") ||
    type === "barge_in" ||
    type.startsWith("monitor")
  )
    return { color: C.accentDeep, soft: C.accentSoft, label };
  if (type.includes("record"))
    return { color: C.amber, soft: C.amberSoft, label };
  return { color: C.textMuted, soft: C.surfaceDeep, label };
}

// datetime-local <-> ISO (treat the picker value as the user's local wall time).
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
function localInputToIso(v: string): string {
  return new Date(v).toISOString();
}

// ─── Date-range presets ─────────────────────────────────────────────────────────
// True rolling windows (now − N), computed in milliseconds — not calendar-day-
// anchored (start-of-day N days back) like some dashboards do. "custom" is the
// escape hatch: it never overwrites startTime/endTime, so the always-visible
// From/To pickers stay the source of truth.
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const DATE_PRESETS: { value: string; label: string }[] = [
  { value: "custom", label: "Custom range" },
  { value: "1h", label: "Last hour" },
  { value: "6h", label: "Last 6 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last week" },
  { value: "3m", label: "Last 3 months" },
  { value: "6m", label: "Last 6 months" },
];

function computePresetRange(preset: string): { start: string; end: string } | null {
  const now = new Date();
  const end = now.toISOString();
  switch (preset) {
    case "1h":
      return { start: new Date(now.getTime() - HOUR_MS).toISOString(), end };
    case "6h":
      return { start: new Date(now.getTime() - 6 * HOUR_MS).toISOString(), end };
    case "24h":
      return { start: new Date(now.getTime() - DAY_MS).toISOString(), end };
    case "7d":
      return { start: new Date(now.getTime() - 7 * DAY_MS).toISOString(), end };
    case "3m": {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 3);
      return { start: d.toISOString(), end };
    }
    case "6m": {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 6);
      return { start: d.toISOString(), end };
    }
    default:
      return null; // "custom"
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────
function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
  "callId",
  "sourcePlatformId",
  "sourcePlatformType",
  "tenantId",
  "callDirection",
  "callType",
  "mediaType",
  "callState",
  "callStartTime",
  "callEndTime",
  "durationSeconds",
  "participantCount",
  "groups",
  "recordingStatus",
];

function toCsv(records: CallRecord[]): string {
  const rows = records.map((r) => {
    const groups = Array.from(
      new Set(r.participants.map((p) => p.group).filter((g): g is string => !!g))
    ).join("; ");
    return [
      r.callId,
      r.sourcePlatformId,
      r.sourcePlatformType,
      r.tenantId,
      r.callDirection,
      r.callType,
      r.mediaType,
      r.callState,
      r.callStartTime,
      r.callEndTime,
      r.durationSeconds,
      r.participants.length,
      groups,
      r.cloudRecording?.recordingStatus,
    ]
      .map(csvCell)
      .join(",");
  });
  return [CSV_COLUMNS.join(","), ...rows].join("\n");
}

const AUDIT_LOG_CSV_COLUMNS = [
  "occurredAt",
  "actorType",
  "actorId",
  "method",
  "path",
  "statusCode",
  "recordCount",
  "ipAddress",
];

function auditLogToCsv(entries: AuditLogEntry[]): string {
  const rows = entries.map((e) =>
    [e.occurredAt, e.actorType, e.actorId, e.method, e.path, e.statusCode, e.recordCount, e.ipAddress]
      .map(csvCell)
      .join(",")
  );
  return [AUDIT_LOG_CSV_COLUMNS.join(","), ...rows].join("\n");
}

// ─── Small UI atoms ───────────────────────────────────────────────────────────
function Pill({
  fg,
  bg,
  children,
}: {
  fg: string;
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: fg,
        background: bg,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          fontSize: 10.5,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: C.textMuted,
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 13, color: C.ink, fontFamily: MONO }}>
        {children ?? "—"}
      </span>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  // Login is always required — see GET /auth/me on mount below. authChecked
  // gates the first render so a logged-out visit doesn't flash the dashboard
  // before the 401 comes back.
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setAuthUser)
      .catch(() => setAuthUser(null))
      .finally(() => setAuthChecked(true));
    // A session can expire or get revoked mid-use — any 401 from anywhere in
    // the app drops straight back to the login screen.
    setUnauthorizedHandler(() => setAuthUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  // Defaults to a real rolling "last 24 hours" window — matches production
  // behavior (a dashboard should open on recent activity, not a fixed
  // historical date). The 2024 demo scenarios and older synthetic data stay
  // reachable via the date pickers or the wider presets, just not on first load.
  const initialRange = computePresetRange("24h")!;
  const [startTime, setStartTime] = useState(initialRange.start);
  const [endTime, setEndTime] = useState(initialRange.end);
  const [datePreset, setDatePreset] = useState("24h");
  const [mediaType, setMediaType] = useState("");
  const [groups, setGroups] = useState("");
  const [sourcePlatformId, setSourcePlatformId] = useState("");
  const [participant, setParticipant] = useState("");
  const [queue, setQueue] = useState("");
  const [ivr, setIvr] = useState("");
  const [advanced, setAdvanced] = useState("");
  const [callIdQuery, setCallIdQuery] = useState("");
  const [callIdError, setCallIdError] = useState<string | null>(null);

  const [records, setRecords] = useState<CallRecord[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [stats, setStats] = useState<StatisticsSummary | null>(null);
  const [talkersInternal, setTalkersInternal] = useState<TopTalker[]>([]);
  const [talkersExternal, setTalkersExternal] = useState<TopTalker[]>([]);
  const [talkersTab, setTalkersTab] = useState<"internal" | "external">("internal");
  const [throughput, setThroughput] = useState<ThroughputPoint[]>([]);
  const [throughputByOutcome, setThroughputByOutcome] = useState<ThroughputOutcomePoint[]>([]);
  const [platformBreakdown, setPlatformBreakdown] = useState<PlatformBreakdownPoint[]>([]);
  const [handleTimeTrend, setHandleTimeTrend] = useState<HandleTimeTrendPoint[]>([]);
  const [agentHandleTime, setAgentHandleTime] = useState<AgentHandleTime[]>([]);
  const [queueWaitTrend, setQueueWaitTrend] = useState<QueueWaitTrendPoint[]>([]);
  const [queueWaitBreakdown, setQueueWaitBreakdown] = useState<QueueWaitBreakdown[]>([]);
  const [worstMosCalls, setWorstMosCalls] = useState<WorstMosCall[]>([]);
  const [ivrTimeTrend, setIvrTimeTrend] = useState<IvrTimeTrendPoint[]>([]);
  const [ivrTimeByIvr, setIvrTimeByIvr] = useState<IvrBreakdown[]>([]);
  const [health, setHealth] = useState<{ status: string; apiVersion: string } | null>(
    null
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CallRecord | null>(null);
  // Drilling across to a related/parent call leg replaces `selected` but keeps
  // a trail back to where you came from — cleared whenever a fresh record is
  // opened from the table rather than drilled into.
  const [drillStack, setDrillStack] = useState<CallRecord[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);
  const [showIngest, setShowIngest] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const insightsParams = {
        startTime,
        endTime,
        mediaType: mediaType || undefined,
        groups: groups || undefined,
        sourcePlatformId: sourcePlatformId || undefined,
      };
      // Hourly buckets read fine up to a few days; wider windows switch to daily
      // so the throughput chart doesn't render hundreds of bars.
      const spanHours =
        (new Date(endTime).getTime() - new Date(startTime).getTime()) / 3_600_000;
      const bucket: "hour" | "day" = spanHours <= 72 ? "hour" : "day";

      const [
        pageRes,
        statsRes,
        internalRes,
        externalRes,
        throughputRes,
        throughputOutcomeRes,
        platformRes,
        handleTimeRes,
        agentHandleTimeRes,
        queueWaitRes,
        queueWaitBreakdownRes,
        worstMosRes,
        ivrTimeRes,
        ivrTimeByIvrRes,
      ] = await Promise.all([
        api.listCalls({
          startTime,
          endTime,
          mediaType: mediaType || undefined,
          groups: groups || undefined,
          sourcePlatformId: sourcePlatformId || undefined,
          participant: participant || undefined,
          queue: queue || undefined,
          ivr: ivr || undefined,
          advanced: advanced || undefined,
          page,
          pageSize,
        }),
        api.statistics(startTime, endTime),
        api.topTalkers({ ...insightsParams, limit: 8, scope: "internal" }),
        api.topTalkers({ ...insightsParams, limit: 8, scope: "external" }),
        api.throughput({ ...insightsParams, bucket }),
        api.throughputByOutcome({ ...insightsParams, bucket }),
        api.byPlatform(insightsParams),
        api.handleTimeTrend({ ...insightsParams, bucket }),
        api.agentHandleTime({ ...insightsParams, limit: 8 }),
        api.queueWaitTrend({ ...insightsParams, bucket }),
        api.queueWaitBreakdown({ ...insightsParams, limit: 8 }),
        api.worstMosCalls({ ...insightsParams, limit: 8 }),
        api.ivrTimeTrend({ ...insightsParams, bucket }),
        api.ivrTimeByIvr({ ...insightsParams, limit: 8 }),
      ]);
      setRecords(pageRes.data);
      setPagination(pageRes.pagination);
      setStats(statsRes);
      setTalkersInternal(internalRes.data);
      setTalkersExternal(externalRes.data);
      setThroughput(throughputRes.data);
      setThroughputByOutcome(throughputOutcomeRes.data);
      setPlatformBreakdown(platformRes.data);
      setHandleTimeTrend(handleTimeRes.data);
      setAgentHandleTime(agentHandleTimeRes.data);
      setQueueWaitTrend(queueWaitRes.data);
      setQueueWaitBreakdown(queueWaitBreakdownRes.data);
      setWorstMosCalls(worstMosRes.data);
      setIvrTimeTrend(ivrTimeRes.data);
      setIvrTimeByIvr(ivrTimeByIvrRes.data);
    } catch (e: any) {
      setError(e.message ?? "Failed to load");
      setRecords([]);
      setPagination(null);
    } finally {
      setLoading(false);
    }
  }, [startTime, endTime, mediaType, groups, sourcePlatformId, participant, queue, ivr, advanced, page, pageSize]);

  useEffect(() => {
    if (authUser) load();
  }, [authUser, load]);
  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  const applyFilters = () => {
    setPage(1);
    load();
  };

  const clearFilters = () => {
    setGroups("");
    setSourcePlatformId("");
    setParticipant("");
    setQueue("");
    setIvr("");
    setAdvanced("");
    setPage(1);
    load();
  };

  const changePageSize = (n: number) => {
    setPageSize(n);
    setPage(1);
  };

  // Presets apply immediately (no separate Apply click, matching how a range
  // picker is expected to behave). Manual edits to From/To fall back to "custom"
  // since the displayed range no longer matches a preset's rolling window.
  const changeDatePreset = (preset: string) => {
    setDatePreset(preset);
    const range = computePresetRange(preset);
    if (range) {
      setStartTime(range.start);
      setEndTime(range.end);
      setPage(1);
    }
  };

  const changeStartManually = (v: string) => {
    setDatePreset("custom");
    setStartTime(v);
  };

  const changeEndManually = (v: string) => {
    setDatePreset("custom");
    setEndTime(v);
  };

  // Drill-down from a Top Talkers row: layer the Participant filter on top of
  // whatever's already active (media type, groups, date range, ...) rather than
  // resetting the view, so "show me their calls" stays in the current context.
  const selectTalker = (identity: string) => {
    setParticipant(identity);
    setPage(1);
  };

  // Drill-down from a Queue Wait Time row — same idea as selectTalker, layered
  // on top of whatever's already active rather than resetting the view.
  const selectQueue = (queueId: string) => {
    setQueue(queueId);
    setPage(1);
  };

  // Drill-down from an IVR Time row — same idea as selectQueue.
  const selectIvr = (ivrId: string) => {
    setIvr(ivrId);
    setPage(1);
  };

  // Opening a call from the Worst MOS table opens its detail drawer directly
  // (each row already identifies one specific call) rather than filtering the
  // table — the same fetch-and-open path drillToCall uses below, just from a
  // starting point with no currently-selected record to push onto a trail.
  const openCallById = async (callId: string) => {
    try {
      const record = await api.getCall(callId);
      selectRecord(record);
    } catch (e: any) {
      setError(e.message ?? `Couldn't load ${callId}`);
    }
  };

  // Jumps straight to a known call/interaction ID, bypassing the current date
  // range and filters entirely (GET /calls/{callId} is an exact lookup, not a
  // filtered list) — the errors here go to their own inline slot rather than
  // the page-level API error banner, since "not found" isn't an API outage.
  // Returns whether the lookup succeeded, so callers (the Filters popover)
  // can close themselves on success but stay open on failure so the inline
  // error is actually visible.
  const lookupCallId = async (): Promise<boolean> => {
    const id = callIdQuery.trim();
    if (!id) return false;
    setCallIdError(null);
    try {
      const record = await api.getCall(id);
      selectRecord(record);
      setCallIdQuery("");
      return true;
    } catch (e: any) {
      setCallIdError(e.message ?? `Couldn't find ${id}`);
      return false;
    }
  };

  // Opening a record fresh from the table starts a new trail — any earlier
  // drill-across history no longer applies to a different starting point.
  const selectRecord = (r: CallRecord) => {
    setSelected(r);
    setDrillStack([]);
    setDrillError(null);
  };

  const closeDrawer = () => {
    setSelected(null);
    setDrillStack([]);
    setDrillError(null);
  };

  // Drill across from the open record to a parent/related call leg — fetches
  // it and swaps the drawer to show it, pushing the current record onto a
  // trail so "Back" can return to it. A leg outside the caller's access scope
  // 404s the same as one that doesn't exist (see backend/getCallRecord), so
  // this surfaces as an ordinary "not found" rather than anything scarier.
  const drillToCall = async (callId: string) => {
    if (!selected) return;
    setDrillLoading(true);
    setDrillError(null);
    try {
      const record = await api.getCall(callId);
      setDrillStack((s) => [...s, selected]);
      setSelected(record);
    } catch (e: any) {
      setDrillError(e.message ?? `Couldn't load ${callId}`);
    } finally {
      setDrillLoading(false);
    }
  };

  const drillBack = () => {
    if (drillStack.length === 0) return;
    setSelected(drillStack[drillStack.length - 1]);
    setDrillStack((s) => s.slice(0, -1));
    setDrillError(null);
  };

  // Pulls every record matching the current filters (not just the visible
  // page) by paging through the API at the max page size.
  const fetchAllMatching = async (): Promise<CallRecord[]> => {
    const base = {
      startTime,
      endTime,
      mediaType: mediaType || undefined,
      groups: groups || undefined,
      sourcePlatformId: sourcePlatformId || undefined,
      participant: participant || undefined,
      queue: queue || undefined,
      ivr: ivr || undefined,
      advanced: advanced || undefined,
      pageSize: 1000,
    };
    const first = await api.listCalls({ ...base, page: 1 });
    const all = [...first.data];
    for (let p = 2; p <= first.pagination.totalPages; p++) {
      const res = await api.listCalls({ ...base, page: p });
      all.push(...res.data);
    }
    return all;
  };

  const handleExport = async (format: "csv" | "json") => {
    setExporting(true);
    setError(null);
    try {
      const all = await fetchAllMatching();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      if (format === "csv") {
        downloadBlob(`cdr-export-${stamp}.csv`, toCsv(all), "text/csv;charset=utf-8");
      } else {
        downloadBlob(`cdr-export-${stamp}.json`, JSON.stringify(all, null, 2), "application/json");
      }
    } catch (e: any) {
      setError(e.message ?? "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } finally {
      setAuthUser(null);
    }
  };

  if (!authChecked) {
    return <div style={{ minHeight: "100vh", background: C.bg }} />;
  }

  if (!authUser) {
    return <LoginScreen onLogin={setAuthUser} />;
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        color: C.ink,
        fontFamily: SANS,
      }}
    >
      <Header
        health={health}
        onIngest={() => setShowIngest(true)}
        authUser={authUser}
        onAuthUserChange={setAuthUser}
        onLogout={handleLogout}
      />

      <main style={{ maxWidth: 1280, margin: "0 auto", padding: "0 20px 64px" }}>
        <FilterBar
          startTime={startTime}
          endTime={endTime}
          datePreset={datePreset}
          mediaType={mediaType}
          groups={groups}
          sourcePlatformId={sourcePlatformId}
          participant={participant}
          queue={queue}
          ivr={ivr}
          advanced={advanced}
          callIdQuery={callIdQuery}
          callIdError={callIdError}
          onStart={changeStartManually}
          onEnd={changeEndManually}
          onPresetChange={changeDatePreset}
          onMedia={setMediaType}
          onGroups={setGroups}
          onSourcePlatformId={setSourcePlatformId}
          onParticipant={setParticipant}
          onQueue={setQueue}
          onIvr={setIvr}
          onAdvanced={setAdvanced}
          onCallIdQueryChange={(v) => {
            setCallIdQuery(v);
            setCallIdError(null);
          }}
          onLookupCallId={lookupCallId}
          onApply={applyFilters}
          onClear={clearFilters}
          showExport={!!pagination && pagination.totalRecords > 0}
          exporting={exporting}
          onExport={handleExport}
        />

        {stats && <StatStrip stats={stats} total={pagination?.totalRecords ?? 0} />}

        {(throughput.length > 0 || talkersInternal.length > 0 || talkersExternal.length > 0) && (
          <InsightsPanel
            throughput={throughput}
            throughputByOutcome={throughputByOutcome}
            platformBreakdown={platformBreakdown}
            handleTimeTrend={handleTimeTrend}
            agentHandleTime={agentHandleTime}
            queueWaitTrend={queueWaitTrend}
            queueWaitBreakdown={queueWaitBreakdown}
            worstMosCalls={worstMosCalls}
            ivrTimeTrend={ivrTimeTrend}
            ivrTimeByIvr={ivrTimeByIvr}
            talkersInternal={talkersInternal}
            talkersExternal={talkersExternal}
            talkersTab={talkersTab}
            onTalkersTabChange={setTalkersTab}
            onSelectTalker={selectTalker}
            onSelectQueue={selectQueue}
            onSelectIvr={selectIvr}
            onOpenCall={openCallById}
          />
        )}

        {error && (
          <div
            style={{
              margin: "16px 0",
              padding: "14px 16px",
              borderRadius: 10,
              background: C.roseSoft,
              color: C.rose,
              border: `1px solid ${C.rose}33`,
              fontSize: 14,
            }}
          >
            Couldn’t reach the CDR API — {error}. Check the backend is running on{" "}
            <code style={{ fontFamily: MONO }}>/api/cdr/v1</code>.
          </div>
        )}

        <RecordsTable
          records={records}
          loading={loading}
          onSelect={selectRecord}
          selectedId={selected?.callId}
        />

        {pagination && pagination.totalRecords > 0 && (
          <Pager
            pagination={pagination}
            pageSize={pageSize}
            onPageSizeChange={changePageSize}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() =>
              setPage((p) => Math.min(pagination.totalPages, p + 1))
            }
          />
        )}
      </main>

      {selected && (
        <DetailDrawer
          record={selected}
          onClose={closeDrawer}
          onBack={drillStack.length > 0 ? drillBack : undefined}
          onDrill={drillToCall}
          drillLoading={drillLoading}
          drillError={drillError}
        />
      )}
      {showIngest && (
        <IngestModal
          onClose={() => setShowIngest(false)}
          onDone={() => {
            setShowIngest(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Set once POST /auth/login comes back with mfaRequired — switches the
  // form to a second step (code entry) instead of username/password.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(username, password);
      if ("mfaRequired" in result) {
        setPendingToken(result.pendingToken);
        return;
      }
      onLogin(result);
    } catch (e: any) {
      setError(e.message ?? "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api.loginMfa(pendingToken!, code);
      onLogin(user);
    } catch (e: any) {
      setError(e.message ?? "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.surface,
    fontSize: 14,
    color: C.ink,
    fontFamily: SANS,
    outline: "none",
    boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.textMuted,
    fontWeight: 700,
    marginBottom: 5,
    display: "block",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        color: C.ink,
        fontFamily: SANS,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <form
        onSubmit={pendingToken ? submitMfa : submit}
        style={{
          width: 360,
          maxWidth: "100%",
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          boxShadow: "0 14px 34px rgba(15,22,32,0.10)",
          padding: 28,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 22 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: C.accent,
              display: "grid",
              placeItems: "center",
              color: "#fff",
              fontSize: 17,
              boxShadow: `0 2px 8px ${C.accent}44`,
            }}
          >
            ◍
          </div>
          <div style={{ lineHeight: 1.1 }}>
            <div style={{ fontWeight: 750, fontSize: 16, letterSpacing: -0.2 }}>
              Open CDR Platform
            </div>
            <div style={{ fontSize: 11.5, color: C.textMuted }}>
              {pendingToken ? "Enter your verification code" : "Sign in to continue"}
            </div>
          </div>
        </div>

        {pendingToken ? (
          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>
              {useRecoveryCode ? "Recovery code" : "6-digit code"}
            </label>
            <input
              type="text"
              autoFocus
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={{ ...inputStyle, fontFamily: MONO }}
            />
            <button
              type="button"
              onClick={() => {
                setUseRecoveryCode((v) => !v);
                setCode("");
                setError(null);
              }}
              style={{
                marginTop: 8,
                border: "none",
                background: "transparent",
                color: C.accentDeep,
                fontSize: 12,
                cursor: "pointer",
                padding: 0,
              }}
            >
              {useRecoveryCode ? "Use an authenticator code instead" : "Use a recovery code instead"}
            </button>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Username</label>
              <input
                type="text"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={labelStyle}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
              />
            </div>
          </>
        )}

        {error && (
          <div
            style={{
              marginBottom: 14,
              padding: "10px 12px",
              borderRadius: 8,
              background: C.roseSoft,
              color: C.rose,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || (pendingToken ? !code : !username || !password)}
          style={{
            width: "100%",
            padding: "10px 14px",
            borderRadius: 8,
            border: "none",
            background:
              busy || (pendingToken ? !code : !username || !password)
                ? C.borderStrong
                : C.accent,
            color: "#fff",
            fontSize: 14,
            fontWeight: 650,
            cursor: busy || (pendingToken ? !code : !username || !password) ? "default" : "pointer",
          }}
        >
          {busy ? "Signing in…" : pendingToken ? "Verify" : "Sign in"}
        </button>

        {pendingToken && (
          <button
            type="button"
            onClick={() => {
              setPendingToken(null);
              setCode("");
              setUseRecoveryCode(false);
              setError(null);
            }}
            style={{
              width: "100%",
              marginTop: 8,
              padding: "8px 14px",
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: C.textMuted,
              fontSize: 12.5,
              cursor: "pointer",
            }}
          >
            ← Back
          </button>
        )}
      </form>
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────
function Header({
  health,
  onIngest,
  authUser,
  onAuthUserChange,
  onLogout,
}: {
  health: { status: string; apiVersion: string } | null;
  onIngest: () => void;
  authUser: AuthUser;
  onAuthUserChange: (user: AuthUser) => void;
  onLogout: () => void;
}) {
  const ok = health?.status === "healthy";
  return (
    <header
      style={{
        borderBottom: `1px solid ${C.border}`,
        background: C.surface,
        position: "sticky",
        top: 0,
        zIndex: 20,
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          padding: "14px 20px",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: C.accent,
              display: "grid",
              placeItems: "center",
              color: "#fff",
              fontSize: 17,
              boxShadow: `0 2px 8px ${C.accent}44`,
            }}
          >
            ◍
          </div>
          <div style={{ lineHeight: 1.1 }}>
            <div style={{ fontWeight: 750, fontSize: 16, letterSpacing: -0.2 }}>
              Open CDR Platform
            </div>
            <div style={{ fontSize: 11.5, color: C.textMuted }}>
              Call detail records · open standard v{health?.apiVersion ?? "1.0.0"}
            </div>
          </div>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12.5,
              color: C.textMid,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: ok ? C.teal : C.rose,
                boxShadow: ok ? `0 0 0 3px ${C.tealSoft}` : `0 0 0 3px ${C.roseSoft}`,
              }}
            />
            {ok ? "API healthy" : "API unreachable"}
          </span>
          <HeaderMenu authUser={authUser} onAuthUserChange={onAuthUserChange} onLogout={onLogout} />
          <button
            onClick={onIngest}
            style={{
              padding: "8px 15px",
              borderRadius: 8,
              border: "none",
              background: C.accent,
              color: "#fff",
              fontSize: 13,
              fontWeight: 650,
              cursor: "pointer",
            }}
          >
            Ingest records
          </button>
        </div>
      </div>
    </header>
  );
}

function fmtRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Houses the peripheral, infrequently-used header items (API docs, backups)
// behind one icon button — keeps the always-visible header down to logo,
// health, this menu, and the primary Ingest CTA, rather than growing a new
// button for every admin-ish thing (backups today, more later).
function HeaderMenu({
  authUser,
  onAuthUserChange,
  onLogout,
}: {
  authUser: AuthUser;
  onAuthUserChange: (user: AuthUser) => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [backups, setBackups] = useState<BackupStatus | null>(null);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [adminKey, setAdminKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const refreshBackups = () => {
    setLoadingBackups(true);
    api
      .backupStatus()
      .then(setBackups)
      .catch(() => setBackups(null))
      .finally(() => setLoadingBackups(false));
  };

  useEffect(() => {
    if (!open || backups || loadingBackups) return;
    refreshBackups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleBackupNow = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const result = await api.triggerBackup(adminKey || undefined);
      setMsg({ ok: true, text: `Backed up (${(result.sizeBytes / 1024).toFixed(0)} KB)` });
      refreshBackups();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Backup failed" });
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async (filename: string) => {
    setMsg(null);
    try {
      const blob = await api.downloadBackupBlob(filename, adminKey || undefined);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Download failed" });
    }
  };

  const handleRestoreFile = async (file: File) => {
    if (
      !window.confirm(
        `Restore "${file.name}"? This replaces the current database outright — everything in it now will be gone.`
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const result = await api.restoreBackup(file, adminKey || undefined);
      setMsg({ ok: true, text: result.message });
      refreshBackups();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Restore failed" });
    } finally {
      setBusy(false);
    }
  };

  const latest = backups?.data[0];
  // One missed scheduled cycle is noise (a slow dump, a brief DB blip); two
  // in a row is a real signal worth flagging rather than staying silent —
  // same reasoning as the failed-attempt marker itself (scripts/backup.sh).
  const backupIsStale =
    !!backups &&
    ((latest &&
      Date.now() - new Date(latest.createdAt).getTime() >
        2 * backups.intervalHours * 3_600_000) ||
      backups.lastAttempt?.status === "failed");

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Menu"
        aria-label="Menu"
        style={{
          width: 32,
          height: 32,
          display: "inline-grid",
          placeItems: "center",
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: C.surface,
          color: C.textMid,
          cursor: "pointer",
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ⋯
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 29 }}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              zIndex: 30,
              width: 340,
              maxHeight: "calc(100vh - 80px)",
              overflowY: "auto",
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 12,
              boxShadow: "0 14px 34px rgba(15,22,32,0.16)",
              padding: 6,
            }}
          >
            <div style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 650,
                    color: C.ink,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={authUser.username}
                >
                  {authUser.username}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, textTransform: "capitalize" }}>
                  {authUser.role}
                </div>
              </div>
              <button
                onClick={onLogout}
                style={{
                  padding: "5px 10px",
                  borderRadius: 6,
                  border: `1px solid ${C.border}`,
                  background: C.surfaceAlt,
                  color: C.textMid,
                  fontSize: 12,
                  fontWeight: 650,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                Log out
              </button>
            </div>
            <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0" }} />
            <SecuritySection authUser={authUser} onAuthUserChange={onAuthUserChange} />
            <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0" }} />
            <ApiKeysSection />
            <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0" }} />
            <a
              href="/api/cdr/v1/docs"
              target="_blank"
              rel="noreferrer"
              style={{
                display: "block",
                padding: "9px 10px",
                borderRadius: 8,
                fontSize: 13,
                color: C.ink,
                textDecoration: "none",
                fontWeight: 600,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.surfaceAlt)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              API docs ↗
            </a>
            <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0" }} />
            <div style={{ padding: "8px 10px" }}>
              <div
                style={{
                  fontSize: 10.5,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: C.textMuted,
                  fontWeight: 700,
                  marginBottom: 6,
                }}
              >
                Backups
              </div>

              {loadingBackups ? (
                <div style={{ fontSize: 12.5, color: C.textMuted }}>Loading…</div>
              ) : !backups?.configured ? (
                <div style={{ fontSize: 12.5, color: C.textMuted }}>
                  Not configured — see README for the `backup` compose service.
                </div>
              ) : (
                <>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: backupIsStale ? C.rose : C.ink,
                    }}
                  >
                    {backupIsStale && "⚠ "}
                    {latest ? `Last backup: ${fmtRelative(latest.createdAt)}` : "No backups yet"}
                  </div>
                  {backups.lastAttempt?.status === "failed" && (
                    <div style={{ fontSize: 11.5, color: C.rose, marginTop: 2 }}>
                      Last scheduled attempt ({fmtRelative(backups.lastAttempt.at)}) failed —
                      check `podman logs opencdr-backup`.
                    </div>
                  )}
                  <div
                    style={{ fontSize: 11.5, color: C.textMuted, fontFamily: MONO, marginTop: 2 }}
                  >
                    {backups.data.length} kept · {backups.retentionDays}d retention · every{" "}
                    {backups.intervalHours}h
                  </div>

                  {backups.data.length > 0 && (
                    <div
                      style={{
                        marginTop: 8,
                        maxHeight: 130,
                        overflowY: "auto",
                        display: "flex",
                        flexDirection: "column",
                        gap: 3,
                      }}
                    >
                      {backups.data.slice(0, 5).map((b) => (
                        <div
                          key={b.filename}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            fontSize: 11.5,
                            padding: "3px 0",
                          }}
                        >
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              color: C.textMid,
                              fontFamily: MONO,
                            }}
                            title={b.filename}
                          >
                            {fmtRelative(b.createdAt)}
                          </span>
                          <span style={{ color: C.textMuted, flexShrink: 0 }}>
                            {(b.sizeBytes / 1024).toFixed(0)}KB
                          </span>
                          <button
                            onClick={() => handleDownload(b.filename)}
                            title={`Download ${b.filename}`}
                            style={{
                              border: "none",
                              background: "transparent",
                              color: C.accentDeep,
                              cursor: "pointer",
                              fontSize: 12,
                              fontWeight: 650,
                              flexShrink: 0,
                              padding: "1px 3px",
                            }}
                          >
                            ⬇
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <input
                    type="password"
                    placeholder="Admin key (if configured)"
                    value={adminKey}
                    onChange={(e) => setAdminKey(e.target.value)}
                    style={{
                      width: "100%",
                      marginTop: 10,
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: `1px solid ${C.border}`,
                      fontSize: 12,
                      fontFamily: MONO,
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                  />

                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <button
                      onClick={handleBackupNow}
                      disabled={busy}
                      style={{
                        flex: 1,
                        padding: "7px 10px",
                        borderRadius: 6,
                        border: "none",
                        background: busy ? C.borderStrong : C.ink,
                        color: "#fff",
                        fontSize: 12,
                        fontWeight: 650,
                        cursor: busy ? "default" : "pointer",
                      }}
                    >
                      Backup now
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={busy}
                      title="Restore from a .dump file"
                      style={{
                        flex: 1,
                        padding: "7px 10px",
                        borderRadius: 6,
                        border: `1px solid ${C.rose}`,
                        background: C.roseSoft,
                        color: C.rose,
                        fontSize: 12,
                        fontWeight: 650,
                        cursor: busy ? "default" : "pointer",
                      }}
                    >
                      Restore…
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".dump"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) handleRestoreFile(file);
                      }}
                    />
                  </div>

                  {msg && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: "6px 8px",
                        borderRadius: 6,
                        fontSize: 11.5,
                        background: msg.ok ? C.tealSoft : C.roseSoft,
                        color: msg.ok ? C.teal : C.rose,
                      }}
                    >
                      {msg.text}
                    </div>
                  )}
                </>
              )}
            </div>

            {authUser.role === "admin" && (
              <>
                <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0" }} />
                <button
                  onClick={() => {
                    setShowAuditLog(true);
                    setOpen(false);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "9px 10px",
                    borderRadius: 8,
                    border: "none",
                    background: "transparent",
                    fontSize: 13,
                    color: C.ink,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = C.surfaceAlt)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  Audit log
                </button>
                <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0" }} />
                <UsersSection currentUsername={authUser.username} />
                <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0" }} />
                <RemoteSourcesSection />
              </>
            )}
          </div>
        </>
      )}
      {showAuditLog && <AuditLogModal onClose={() => setShowAuditLog(false)} />}
    </div>
  );
}

// Self-service MFA — every logged-in user manages their own second factor.
// Admins additionally get a reset action for the "lost my device" case (see
// UsersSection). No QR code rendering — the raw secret + otpauth:// URI as
// copyable text is fully functional (every authenticator app supports
// manual entry) without pulling in a second new dependency just for this.
function SecuritySection({
  authUser,
  onAuthUserChange,
}: {
  authUser: AuthUser;
  onAuthUserChange: (user: AuthUser) => void;
}) {
  const [showSetup, setShowSetup] = useState(false);
  const [showDisable, setShowDisable] = useState(false);

  return (
    <div style={{ padding: "8px 10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: C.textMuted,
            fontWeight: 700,
          }}
        >
          Security
        </div>
        <button
          onClick={() => (authUser.mfaEnabled ? setShowDisable(true) : setShowSetup(true))}
          style={{
            border: "none",
            background: "transparent",
            color: authUser.mfaEnabled ? C.rose : C.accentDeep,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 650,
            padding: 0,
          }}
        >
          {authUser.mfaEnabled ? "Disable MFA" : "Enable MFA"}
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: C.textMid }}>
        Two-factor authentication:{" "}
        <span style={{ fontWeight: 650, color: authUser.mfaEnabled ? C.teal : C.textMuted }}>
          {authUser.mfaEnabled ? "Enabled" : "Not enabled"}
        </span>
      </div>

      {showSetup && (
        <MfaSetupModal
          onClose={() => setShowSetup(false)}
          onEnabled={() => {
            setShowSetup(false);
            onAuthUserChange({ ...authUser, mfaEnabled: true });
          }}
        />
      )}
      {showDisable && (
        <MfaDisableModal
          onClose={() => setShowDisable(false)}
          onDisabled={() => {
            setShowDisable(false);
            onAuthUserChange({ ...authUser, mfaEnabled: false });
          }}
        />
      )}
    </div>
  );
}

function MfaSetupModal({ onClose, onEnabled }: { onClose: () => void; onEnabled: () => void }) {
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.mfa
      .setup()
      .then(setEnrollment)
      .catch((e: any) => setMsg({ ok: false, text: e.message ?? "Couldn’t start MFA setup" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.mfa.confirm(code);
      setRecoveryCodes(res.recoveryCodes);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Invalid code" });
    } finally {
      setBusy(false);
    }
  };

  const secretGrouped = enrollment?.secret.match(/.{1,4}/g)?.join(" ") ?? "";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,22,32,0.38)",
        zIndex: 50,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 100%)",
          background: C.surface,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(15,22,32,0.3)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {recoveryCodes ? "Save your recovery codes" : "Enable two-factor authentication"}
            </div>
            {!recoveryCodes && (
              <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>
                Scan or enter this into your authenticator app, then confirm a code.
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              fontSize: 22,
              cursor: "pointer",
              color: C.textMuted,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 20 }}>
          {recoveryCodes ? (
            <>
              <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 10 }}>
                Each code works once, if you lose access to your authenticator. They won’t be
                shown again.
              </div>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 13,
                  color: C.ink,
                  background: C.surfaceAlt,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: 12,
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 6,
                  userSelect: "all",
                }}
              >
                {recoveryCodes.map((c) => (
                  <div key={c}>{c}</div>
                ))}
              </div>
              <button
                onClick={onEnabled}
                style={{
                  width: "100%",
                  marginTop: 16,
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: "none",
                  background: C.accent,
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 650,
                  cursor: "pointer",
                }}
              >
                I’ve saved these — done
              </button>
            </>
          ) : !enrollment ? (
            <div style={{ fontSize: 12.5, color: C.textMuted }}>
              {msg ? msg.text : "Loading…"}
            </div>
          ) : (
            <>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 15,
                  letterSpacing: 1,
                  textAlign: "center",
                  color: C.ink,
                  background: C.surfaceAlt,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 8,
                  userSelect: "all",
                }}
              >
                {secretGrouped}
              </div>
              <details style={{ marginBottom: 14 }}>
                <summary style={{ fontSize: 11.5, color: C.textMuted, cursor: "pointer" }}>
                  otpauth:// URI
                </summary>
                <div
                  style={{
                    fontFamily: MONO,
                    fontSize: 10.5,
                    color: C.textMid,
                    marginTop: 6,
                    wordBreak: "break-all",
                    userSelect: "all",
                  }}
                >
                  {enrollment.otpauthUri}
                </div>
              </details>

              <label
                style={{
                  fontSize: 10.5,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  color: C.textMuted,
                  fontWeight: 700,
                  marginBottom: 5,
                  display: "block",
                }}
              >
                6-digit code
              </label>
              <input
                type="text"
                autoFocus
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${C.border}`,
                  background: C.surface,
                  fontSize: 14,
                  fontFamily: MONO,
                  outline: "none",
                  boxSizing: "border-box",
                  marginBottom: 12,
                }}
              />

              {msg && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: "9px 11px",
                    borderRadius: 8,
                    background: msg.ok ? C.tealSoft : C.roseSoft,
                    color: msg.ok ? C.teal : C.rose,
                    fontSize: 12.5,
                  }}
                >
                  {msg.text}
                </div>
              )}

              <button
                onClick={confirm}
                disabled={busy || !code}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: "none",
                  background: busy || !code ? C.borderStrong : C.accent,
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 650,
                  cursor: busy || !code ? "default" : "pointer",
                }}
              >
                {busy ? "Confirming…" : "Confirm"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MfaDisableModal({
  onClose,
  onDisabled,
}: {
  onClose: () => void;
  onDisabled: () => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const smallInput: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.surface,
    fontSize: 14,
    fontFamily: SANS,
    outline: "none",
    boxSizing: "border-box",
    marginBottom: 12,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.textMuted,
    fontWeight: 700,
    marginBottom: 5,
    display: "block",
  };

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.mfa.disable(password, code);
      onDisabled();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t disable MFA" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,22,32,0.38)",
        zIndex: 50,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(380px, 100%)",
          background: C.surface,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(15,22,32,0.3)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Disable two-factor authentication</div>
            <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>
              Confirm your password and a current code (or a recovery code).
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              fontSize: 22,
              cursor: "pointer",
              color: C.textMuted,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 20 }}>
          <label style={labelStyle}>Password</label>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={smallInput}
          />
          <label style={labelStyle}>Code</label>
          <input
            type="text"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            style={{ ...smallInput, fontFamily: MONO }}
          />

          {msg && (
            <div
              style={{
                marginBottom: 12,
                padding: "9px 11px",
                borderRadius: 8,
                background: C.roseSoft,
                color: C.rose,
                fontSize: 12.5,
              }}
            >
              {msg.text}
            </div>
          )}

          <button
            onClick={submit}
            disabled={busy || !password || !code}
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: 8,
              border: "none",
              background: busy || !password || !code ? C.borderStrong : C.rose,
              color: "#fff",
              fontSize: 14,
              fontWeight: 650,
              cursor: busy || !password || !code ? "default" : "pointer",
            }}
          >
            {busy ? "Disabling…" : "Disable MFA"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Self-service API keys — every logged-in user manages their own, unlike
// UsersSection below which is admin-only. A key acts as its owner: same
// role, same scope, enforced the same way the session cookie already is
// (see requireAuth/scopeFilters on the backend).
function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; key: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = () => {
    setLoading(true);
    api.apiKeys
      .list()
      .then((res) => setKeys(res.data))
      .catch(() => setKeys(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const created = await api.apiKeys.create(newName);
      setRevealed({ name: created.name, key: created.key });
      setNewName("");
      setShowAdd(false);
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t create key" });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (k: ApiKeyMeta) => {
    if (
      !window.confirm(`Revoke API key "${k.name}"? Anything using it will stop working immediately.`)
    ) {
      return;
    }
    setMsg(null);
    try {
      await api.apiKeys.remove(k.id);
      if (revealed) setRevealed(null);
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t revoke key" });
    }
  };

  const smallInput: React.CSSProperties = {
    width: "100%",
    padding: "6px 8px",
    borderRadius: 6,
    border: `1px solid ${C.border}`,
    fontSize: 12,
    fontFamily: SANS,
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div style={{ padding: "8px 10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: C.textMuted,
            fontWeight: 700,
          }}
        >
          API keys
        </div>
        <button
          onClick={() => {
            setShowAdd((v) => !v);
            setRevealed(null);
          }}
          style={{
            border: "none",
            background: "transparent",
            color: C.accentDeep,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 650,
            padding: 0,
          }}
        >
          {showAdd ? "Cancel" : "+ New key"}
        </button>
      </div>

      {revealed && (
        <div
          style={{
            marginBottom: 8,
            padding: "8px 9px",
            borderRadius: 6,
            background: C.tealSoft,
            border: `1px solid ${C.teal}44`,
          }}
        >
          <div style={{ fontSize: 11.5, color: C.teal, fontWeight: 650, marginBottom: 4 }}>
            “{revealed.name}” created — copy it now, it won’t be shown again:
          </div>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 11.5,
              color: C.ink,
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 5,
              padding: "6px 7px",
              wordBreak: "break-all",
              userSelect: "all",
              cursor: "text",
            }}
          >
            {revealed.key}
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 12.5, color: C.textMuted }}>Loading…</div>
      ) : !keys || keys.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.textMuted }}>No API keys yet.</div>
      ) : (
        <div
          style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 150, overflowY: "auto" }}
        >
          {keys.map((k) => (
            <div
              key={k.id}
              style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    color: C.ink,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={k.name}
                >
                  {k.name}
                </div>
                <div style={{ color: C.textMuted, fontSize: 11, fontFamily: MONO }}>
                  {k.keyPrefix}… · {k.lastUsedAt ? `used ${fmtRelative(k.lastUsedAt)}` : "never used"}
                </div>
              </div>
              <button
                onClick={() => handleDelete(k)}
                title={`Revoke ${k.name}`}
                style={{
                  border: "none",
                  background: "transparent",
                  color: C.rose,
                  cursor: "pointer",
                  fontSize: 12,
                  flexShrink: 0,
                  padding: "1px 3px",
                }}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <form onSubmit={handleAdd} style={{ marginTop: 10, display: "flex", gap: 6 }}>
          <input
            placeholder="Key name (e.g. laptop script)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            style={smallInput}
          />
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: "7px 12px",
              borderRadius: 6,
              border: "none",
              background: busy ? C.borderStrong : C.ink,
              color: "#fff",
              fontSize: 12,
              fontWeight: 650,
              cursor: busy ? "default" : "pointer",
              flexShrink: 0,
            }}
          >
            {busy ? "…" : "Create"}
          </button>
        </form>
      )}

      {msg && (
        <div
          style={{
            marginTop: 8,
            padding: "6px 8px",
            borderRadius: 6,
            fontSize: 11.5,
            background: msg.ok ? C.tealSoft : C.roseSoft,
            color: msg.ok ? C.teal : C.rose,
          }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

// Admin-only user management, folded into the ⋯ menu rather than a separate
// settings page — list existing users, add one, delete one. Editing role/scope
// of an existing user isn't exposed in the UI yet (delete + recreate covers
// it for now); the PATCH endpoint exists for future use.
function UsersSection({ currentUsername }: { currentUsername: string }) {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "viewer">("viewer");
  const [newGroups, setNewGroups] = useState("");
  const [newPlatforms, setNewPlatforms] = useState("");
  const [busy, setBusy] = useState(false);

  // Only one row edits at a time — mutually exclusive with the add-user form.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editRole, setEditRole] = useState<"admin" | "viewer">("viewer");
  const [editGroups, setEditGroups] = useState("");
  const [editPlatforms, setEditPlatforms] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  const refresh = () => {
    setLoading(true);
    api.users
      .list()
      .then((res) => setUsers(res.data))
      .catch(() => setUsers(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parseScope = (v: string) => {
    const list = v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length ? list : null;
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.users.create({
        username: newUsername,
        password: newPassword,
        role: newRole,
        allowedGroups: parseScope(newGroups),
        allowedSourcePlatformIds: parseScope(newPlatforms),
      });
      setNewUsername("");
      setNewPassword("");
      setNewRole("viewer");
      setNewGroups("");
      setNewPlatforms("");
      setShowAdd(false);
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t create user" });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (user: ManagedUser) => {
    if (!window.confirm(`Delete user "${user.username}"? This can’t be undone.`)) return;
    setMsg(null);
    try {
      await api.users.remove(user.id);
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t delete user" });
    }
  };

  // "Lost my device" escape hatch — clears MFA so the user can log in with
  // just a password again and re-enroll if they want to.
  const handleResetMfa = async (user: ManagedUser) => {
    if (
      !window.confirm(
        `Reset MFA for "${user.username}"? They'll be able to log in with just their password until they re-enroll.`
      )
    ) {
      return;
    }
    setMsg(null);
    try {
      await api.users.resetMfa(user.id);
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t reset MFA" });
    }
  };

  const startEdit = (user: ManagedUser) => {
    setShowAdd(false);
    setMsg(null);
    setEditingId(user.id);
    setEditRole(user.role);
    setEditGroups((user.allowedGroups ?? []).join(", "));
    setEditPlatforms((user.allowedSourcePlatformIds ?? []).join(", "));
    setEditPassword("");
  };

  const cancelEdit = () => setEditingId(null);

  const handleEditSubmit = async (e: React.FormEvent, user: ManagedUser) => {
    e.preventDefault();
    if (
      user.username === currentUsername &&
      editRole !== "admin" &&
      !window.confirm(
        "You're changing your own role away from admin — you'll lose admin access immediately. Continue?"
      )
    ) {
      return;
    }
    setEditBusy(true);
    setMsg(null);
    try {
      await api.users.update(user.id, {
        role: editRole,
        allowedGroups: parseScope(editGroups),
        allowedSourcePlatformIds: parseScope(editPlatforms),
        ...(editPassword ? { password: editPassword } : {}),
      });
      setEditingId(null);
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t update user" });
    } finally {
      setEditBusy(false);
    }
  };

  const scopeLabel = (list: string[] | null) => (list ? list.join(", ") : "unrestricted");

  const smallInput: React.CSSProperties = {
    width: "100%",
    padding: "6px 8px",
    borderRadius: 6,
    border: `1px solid ${C.border}`,
    fontSize: 12,
    fontFamily: SANS,
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div style={{ padding: "8px 10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: C.textMuted,
            fontWeight: 700,
          }}
        >
          Users
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setShowAdd((v) => !v);
          }}
          style={{
            border: "none",
            background: "transparent",
            color: C.accentDeep,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 650,
            padding: 0,
          }}
        >
          {showAdd ? "Cancel" : "+ Add user"}
        </button>
      </div>

      {loading ? (
        <div style={{ fontSize: 12.5, color: C.textMuted }}>Loading…</div>
      ) : !users || users.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.textMuted }}>No users yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 220, overflowY: "auto" }}>
          {users.map((u) =>
            editingId === u.id ? (
              <form
                key={u.id}
                onSubmit={(e) => handleEditSubmit(e, u)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: "8px 0",
                  borderTop: `1px solid ${C.border}`,
                }}
              >
                <div style={{ fontWeight: 650, fontSize: 12, color: C.ink }}>
                  Editing {u.username}
                </div>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as "admin" | "viewer")}
                  style={smallInput}
                >
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                </select>
                <input
                  placeholder="Allowed groups (blank = unrestricted)"
                  value={editGroups}
                  onChange={(e) => setEditGroups(e.target.value)}
                  style={smallInput}
                />
                <input
                  placeholder="Allowed source platform IDs (blank = unrestricted)"
                  value={editPlatforms}
                  onChange={(e) => setEditPlatforms(e.target.value)}
                  style={smallInput}
                />
                <input
                  type="password"
                  placeholder="New password (leave blank to keep current)"
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  minLength={8}
                  style={smallInput}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="submit"
                    disabled={editBusy}
                    style={{
                      flex: 1,
                      padding: "7px 10px",
                      borderRadius: 6,
                      border: "none",
                      background: editBusy ? C.borderStrong : C.ink,
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 650,
                      cursor: editBusy ? "default" : "pointer",
                    }}
                  >
                    {editBusy ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    style={{
                      flex: 1,
                      padding: "7px 10px",
                      borderRadius: 6,
                      border: `1px solid ${C.border}`,
                      background: C.surface,
                      color: C.textMid,
                      fontSize: 12,
                      fontWeight: 650,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div
                key={u.id}
                style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12 }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: C.ink, fontWeight: 600 }}>
                    {u.username}{" "}
                    <span style={{ color: C.textMuted, fontWeight: 500 }}>· {u.role}</span>
                    {u.mfaEnabled && (
                      <span style={{ color: C.teal, fontWeight: 600 }} title="MFA enabled">
                        {" "}
                        · MFA
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      color: C.textMuted,
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={`Groups: ${scopeLabel(u.allowedGroups)} · Platforms: ${scopeLabel(u.allowedSourcePlatformIds)}`}
                  >
                    {scopeLabel(u.allowedGroups)} / {scopeLabel(u.allowedSourcePlatformIds)}
                  </div>
                </div>
                <button
                  onClick={() => startEdit(u)}
                  title={`Edit ${u.username}`}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: C.accentDeep,
                    cursor: "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                    padding: "1px 3px",
                  }}
                >
                  Edit
                </button>
                {u.mfaEnabled && (
                  <button
                    onClick={() => handleResetMfa(u)}
                    title={`Reset MFA for ${u.username}`}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: C.amber,
                      cursor: "pointer",
                      fontSize: 12,
                      flexShrink: 0,
                      padding: "1px 3px",
                    }}
                  >
                    Reset MFA
                  </button>
                )}
                {u.username !== currentUsername && (
                  <button
                    onClick={() => handleDelete(u)}
                    title={`Delete ${u.username}`}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: C.rose,
                      cursor: "pointer",
                      fontSize: 12,
                      flexShrink: 0,
                      padding: "1px 3px",
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            )
          )}
        </div>
      )}

      {showAdd && (
        <form onSubmit={handleAdd} style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            placeholder="Username"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            required
            style={smallInput}
          />
          <input
            type="password"
            placeholder="Password (min 8 characters)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
            style={smallInput}
          />
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as "admin" | "viewer")}
            style={smallInput}
          >
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
          <input
            placeholder="Allowed groups (blank = unrestricted)"
            value={newGroups}
            onChange={(e) => setNewGroups(e.target.value)}
            style={smallInput}
          />
          <input
            placeholder="Allowed source platform IDs (blank = unrestricted)"
            value={newPlatforms}
            onChange={(e) => setNewPlatforms(e.target.value)}
            style={smallInput}
          />
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: "7px 10px",
              borderRadius: 6,
              border: "none",
              background: busy ? C.borderStrong : C.ink,
              color: "#fff",
              fontSize: 12,
              fontWeight: 650,
              cursor: busy ? "default" : "pointer",
            }}
          >
            {busy ? "Creating…" : "Create user"}
          </button>
        </form>
      )}

      {msg && (
        <div
          style={{
            marginTop: 8,
            padding: "6px 8px",
            borderRadius: 6,
            fontSize: 11.5,
            background: msg.ok ? C.tealSoft : C.roseSoft,
            color: msg.ok ? C.teal : C.rose,
          }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function pollStatusStyle(status: RemotePollStatus | null): { fg: string; bg: string; label: string } {
  if (status === "ok") return { fg: C.teal, bg: C.tealSoft, label: "ok" };
  if (status === "validation_rejects") return { fg: C.amber, bg: C.amberSoft, label: "rejects" };
  if (status === "auth_error") return { fg: C.rose, bg: C.roseSoft, label: "auth error" };
  if (status === "fetch_error") return { fg: C.rose, bg: C.roseSoft, label: "fetch error" };
  return { fg: C.textMuted, bg: C.surfaceAlt, label: "never polled" };
}

// Paginated view of one remote source's rejected (failed-validation) pulled
// records — a lighter version of AuditLogModal's table/pagination skeleton
// (no filter bar; this is already scoped to one source), reusing the same
// generic Pager component and full-screen modal chrome as IngestModal.
function RemoteSourceRejectsModal({
  sourceId,
  sourceName,
  onClose,
}: {
  sourceId: number;
  sourceName: string;
  onClose: () => void;
}) {
  const [rejects, setRejects] = useState<RemoteSourceReject[] | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const load = (p: number, ps: number) => {
    setLoading(true);
    setError(null);
    api.remoteSources
      .rejects(sourceId, { page: p, pageSize: ps })
      .then((res) => {
        setRejects(res.data);
        setPagination(res.pagination);
        setPage(p);
        setPageSize(ps);
      })
      .catch((e: any) => {
        setError(e.message ?? "Failed to load rejects");
        setRejects([]);
        setPagination(null);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(1, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,22,32,0.38)",
        zIndex: 55,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(760px, 100%)",
          maxHeight: "min(640px, 100%)",
          display: "flex",
          flexDirection: "column",
          background: C.surface,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(15,22,32,0.3)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Rejected records</div>
            <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>{sourceName}</div>
          </div>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              fontSize: 22,
              cursor: "pointer",
              color: C.textMuted,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: "16px 20px", overflow: "auto", flex: 1 }}>
          {error && (
            <div
              style={{
                marginBottom: 12,
                padding: "10px 12px",
                borderRadius: 8,
                background: C.roseSoft,
                color: C.rose,
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
          {loading ? (
            <div style={{ fontSize: 13, color: C.textMuted }}>Loading…</div>
          ) : !rejects || rejects.length === 0 ? (
            <div style={{ fontSize: 13, color: C.textMuted }}>No rejected records.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rejects.map((r) => (
                <div
                  key={r.id}
                  style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                    <span style={{ fontFamily: MONO, fontSize: 12, color: C.textMuted }}>
                      {fmt(r.occurredAt)}
                    </span>
                    {r.callId && (
                      <span style={{ fontFamily: MONO, fontSize: 12, color: C.textMid }}>{r.callId}</span>
                    )}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12.5, color: C.rose, whiteSpace: "pre-wrap" }}>
                    {r.validationError}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {pagination && pagination.totalRecords > 0 && (
          <div style={{ padding: "0 20px 16px" }}>
            <Pager
              pagination={pagination}
              pageSize={pageSize}
              onPageSizeChange={(n) => load(1, n)}
              onPrev={() => load(Math.max(1, page - 1), pageSize)}
              onNext={() => load(Math.min(pagination.totalPages, page + 1), pageSize)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface ExampleScript {
  id: string;
  name: string;
  description: string;
  scriptBody: string;
  envHint: string;
}

// Reference starting points for the "Custom script (Python)" auth type —
// stdlib-only except the SFTP one, which needs python3-paramiko (bundled in
// the backend image specifically so this flagship example — the whole
// motivating use case for this feature, a CUCM-style file export — actually
// runs rather than immediately failing with ModuleNotFoundError).
const EXAMPLE_SCRIPTS: ExampleScript[] = [
  {
    id: "minimal",
    name: "Minimal template",
    description:
      "The bare contract and nothing else — reads WATERMARK, returns an empty result, exits 0. Stdlib only, always runs. Start here and build up.",
    envHint: "",
    scriptBody: `import json
import os

# Every run gets WATERMARK (the source's last successful watermark, or its
# backfillFrom on the very first run) plus whatever env vars you configured
# for this source below.
watermark = os.environ.get("WATERMARK")

records = []  # append CallRecord-shaped dicts here

# Advance the watermark to reflect what you actually processed — the backend
# falls back to "now" if you leave this unchanged, so it's safe to start with
# this and refine once real data is flowing.
new_watermark = watermark

print(json.dumps({"records": records, "watermark": new_watermark}))
`,
  },
  {
    id: "http-json",
    name: "Generic HTTP JSON API",
    description:
      "Pulls CDRs from a JSON REST API using only Python's stdlib (urllib) — no extra packages needed.",
    envHint: "API_BASE_URL=https://example.com/api/cdrs\nAPI_KEY=",
    scriptBody: `import json
import os
import urllib.request
from datetime import datetime, timezone

base_url = os.environ["API_BASE_URL"]
api_key = os.environ.get("API_KEY", "")
watermark = os.environ.get("WATERMARK")

url = f"{base_url}?since={watermark}"
headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as resp:
    raw_records = json.loads(resp.read())

records = []
for r in raw_records:
    # Map the remote's own field names onto Open CDR's CallRecord shape —
    # adjust this block to match whatever the real API actually returns.
    records.append({
        "callId": r["id"],
        "callStartTime": r["startTime"],
        "callEndTime": r.get("endTime"),
        "callState": "ended" if r.get("endTime") else "ongoing",
        "mediaType": "voice",
        "participants": [
            {"participantId": "p1", "role": "caller", "extension": r["from"]},
            {"participantId": "p2", "role": "callee", "extension": r["to"]},
        ],
    })

new_watermark = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
print(json.dumps({"records": records, "watermark": new_watermark}))
`,
  },
  {
    id: "http-csv",
    name: "CSV export over HTTP",
    description: "Downloads and parses a CSV CDR export via HTTP — stdlib only (urllib + csv).",
    envHint: "CSV_URL=https://example.com/cdr-export.csv",
    scriptBody: `import csv
import io
import json
import os
import urllib.request
from datetime import datetime, timezone

csv_url = os.environ["CSV_URL"]

with urllib.request.urlopen(csv_url, timeout=30) as resp:
    text = resp.read().decode("utf-8")

records = []
for row in csv.DictReader(io.StringIO(text)):
    # Adjust these column names to match your actual CSV export.
    records.append({
        "callId": row["CallID"],
        "callStartTime": row["StartTime"],
        "callEndTime": row.get("EndTime") or None,
        "callState": "ended",
        "mediaType": "voice",
        "participants": [
            {"participantId": "p1", "role": "caller", "extension": row["CallingNumber"]},
            {"participantId": "p2", "role": "callee", "extension": row["FinalCalledNumber"]},
        ],
    })

new_watermark = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
print(json.dumps({"records": records, "watermark": new_watermark}))
`,
  },
  {
    id: "sftp-cucm",
    name: "SFTP file scan (Cisco CUCM-style)",
    description:
      "Connects to an SFTP server, lists CDR files newer than the watermark, parses each as CSV. The motivating example for this feature — see the Roadmap.",
    envHint: "SFTP_HOST=\nSFTP_PORT=22\nSFTP_USER=\nSFTP_PASSWORD=\nSFTP_DIR=/cdr-export",
    scriptBody: `import csv
import io
import json
import os
from datetime import datetime, timezone

import paramiko

host = os.environ["SFTP_HOST"]
port = int(os.environ.get("SFTP_PORT", "22"))
username = os.environ["SFTP_USER"]
password = os.environ["SFTP_PASSWORD"]
remote_dir = os.environ.get("SFTP_DIR", "/")
watermark = os.environ.get("WATERMARK")
watermark_dt = datetime.fromisoformat(watermark.replace("Z", "+00:00")) if watermark else None

transport = paramiko.Transport((host, port))
transport.connect(username=username, password=password)
sftp = paramiko.SFTPClient.from_transport(transport)

records = []
latest_mtime = watermark_dt
try:
    for entry in sftp.listdir_attr(remote_dir):
        mtime = datetime.fromtimestamp(entry.st_mtime, tz=timezone.utc)
        if watermark_dt and mtime <= watermark_dt:
            continue
        if not entry.filename.endswith(".csv"):
            continue

        with sftp.open(f"{remote_dir}/{entry.filename}") as f:
            content = f.read().decode("utf-8")

        # CUCM CDR files are CSV with a header row — adjust field names to
        # match your cluster's actual CDR field export configuration.
        for row in csv.DictReader(io.StringIO(content)):
            records.append({
                "callId": row.get("globalCallID_callId") or row.get("CallID"),
                "callStartTime": row["dateTimeOrigination"],
                "callEndTime": row.get("dateTimeDisconnect"),
                "callState": "ended",
                "mediaType": "voice",
                "participants": [
                    {"participantId": "p1", "role": "caller", "extension": row["callingPartyNumber"]},
                    {"participantId": "p2", "role": "callee", "extension": row["finalCalledPartyNumber"]},
                ],
            })

        if latest_mtime is None or mtime > latest_mtime:
            latest_mtime = mtime
finally:
    sftp.close()
    transport.close()

new_watermark = (latest_mtime or datetime.now(timezone.utc)).isoformat().replace("+00:00", "Z")
print(json.dumps({"records": records, "watermark": new_watermark}))
`,
  },
];

function ExampleScriptsModal({
  onUse,
  onClose,
}: {
  onUse: (script: ExampleScript) => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,22,32,0.38)",
        zIndex: 60,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 100%)",
          maxHeight: "min(640px, 100%)",
          display: "flex",
          flexDirection: "column",
          background: C.surface,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(15,22,32,0.3)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Example scripts</div>
            <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>
              Starting points — pick one, then adjust the field mapping and env vars for your real source.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              fontSize: 22,
              cursor: "pointer",
              color: C.textMuted,
            }}
          >
            ×
          </button>
        </div>
        <div
          style={{
            padding: 16,
            overflow: "auto",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {EXAMPLE_SCRIPTS.map((ex) => (
            <div key={ex.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontWeight: 650, fontSize: 13.5, color: C.ink }}>{ex.name}</div>
                <button
                  onClick={() => onUse(ex)}
                  style={{
                    marginLeft: "auto",
                    padding: "5px 12px",
                    borderRadius: 6,
                    border: "none",
                    background: C.ink,
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 650,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  Use this
                </button>
              </div>
              <div style={{ fontSize: 12, color: C.textMid, marginTop: 4, lineHeight: 1.4 }}>{ex.description}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Admin-only, DB-backed config for pulling CDRs from another Open-CDR-compatible
// platform's own GET /calls, on top of this platform's existing push-based
// POST /calls/ingest — see backend/src/services/remotePollService.ts. Follows
// the UsersSection template (inline list + add-form + per-row edit state)
// rather than the smaller Backups-panel pattern, since multi-source + two
// auth-type sub-forms is comparable complexity to user management.
function RemoteSourcesSection() {
  const [sources, setSources] = useState<RemoteSourceMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pollingId, setPollingId] = useState<number | null>(null);
  const [rejectsSource, setRejectsSource] = useState<RemoteSourceMeta | null>(null);
  const [showExamples, setShowExamples] = useState(false);

  const [newName, setNewName] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newPollInterval, setNewPollInterval] = useState("15");
  const [newBackfillFrom, setNewBackfillFrom] = useState(() => isoToLocalInput(new Date().toISOString()));
  const [newAuthType, setNewAuthType] = useState<RemoteSourceAuthType>("api_key");
  const [newApiKey, setNewApiKey] = useState("");
  const [newHeaderName, setNewHeaderName] = useState("");
  const [newTokenUrl, setNewTokenUrl] = useState("");
  const [newClientId, setNewClientId] = useState("");
  const [newClientSecret, setNewClientSecret] = useState("");
  const [newScope, setNewScope] = useState("");
  const [newScriptBody, setNewScriptBody] = useState("");
  const [newEnvText, setNewEnvText] = useState("");
  const [newAcceptLiability, setNewAcceptLiability] = useState(false);

  // Only one row edits at a time — mutually exclusive with the add-source form.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editPollInterval, setEditPollInterval] = useState("15");
  const [editRotateAuth, setEditRotateAuth] = useState(false);
  const [editAuthType, setEditAuthType] = useState<RemoteSourceAuthType>("api_key");
  const [editApiKey, setEditApiKey] = useState("");
  const [editHeaderName, setEditHeaderName] = useState("");
  const [editTokenUrl, setEditTokenUrl] = useState("");
  const [editClientId, setEditClientId] = useState("");
  const [editClientSecret, setEditClientSecret] = useState("");
  const [editScope, setEditScope] = useState("");
  const [editScriptBody, setEditScriptBody] = useState("");
  const [editEnvText, setEditEnvText] = useState("");
  const [editAcceptLiability, setEditAcceptLiability] = useState(false);
  const [editBusy, setEditBusy] = useState(false);

  const refresh = () => {
    setLoading(true);
    api.remoteSources
      .list()
      .then((res) => setSources(res.data))
      .catch(() => setSources(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // KEY=value, one per line — trims each line, skips blanks and lines with
  // no "=", splits on the *first* "=" only (so values may contain one), and
  // last-value-wins on a duplicate key.
  const parseEnvLines = (text: string): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!key) continue;
      env[key] = line.slice(eq + 1).trim();
    }
    return env;
  };

  const buildAuth = (fields: {
    authType: RemoteSourceAuthType;
    apiKey: string;
    headerName: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope: string;
    scriptBody: string;
    envText: string;
  }): RemoteSourceAuthInput => {
    if (fields.authType === "api_key") {
      return { authType: "api_key", apiKey: fields.apiKey, headerName: fields.headerName || undefined };
    }
    if (fields.authType === "oauth2_client_credentials") {
      return {
        authType: "oauth2_client_credentials",
        tokenUrl: fields.tokenUrl,
        clientId: fields.clientId,
        clientSecret: fields.clientSecret,
        scope: fields.scope || undefined,
      };
    }
    return { authType: "custom", scriptBody: fields.scriptBody, env: parseEnvLines(fields.envText) };
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.remoteSources.create({
        name: newName,
        baseUrl: newBaseUrl,
        pollIntervalMinutes: Number(newPollInterval) || 15,
        backfillFrom: localInputToIso(newBackfillFrom),
        auth: buildAuth({
          authType: newAuthType,
          apiKey: newApiKey,
          headerName: newHeaderName,
          tokenUrl: newTokenUrl,
          clientId: newClientId,
          clientSecret: newClientSecret,
          scope: newScope,
          scriptBody: newScriptBody,
          envText: newEnvText,
        }),
      });
      setNewName("");
      setNewBaseUrl("");
      setNewPollInterval("15");
      setNewBackfillFrom(isoToLocalInput(new Date().toISOString()));
      setNewAuthType("api_key");
      setNewApiKey("");
      setNewHeaderName("");
      setNewTokenUrl("");
      setNewClientId("");
      setNewClientSecret("");
      setNewScope("");
      setNewScriptBody("");
      setNewEnvText("");
      setNewAcceptLiability(false);
      setShowAdd(false);
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t create remote source" });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (source: RemoteSourceMeta) => {
    if (!window.confirm(`Delete remote source "${source.name}"? This can’t be undone.`)) return;
    setMsg(null);
    try {
      await api.remoteSources.remove(source.id);
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t delete remote source" });
    }
  };

  const handleToggleEnabled = async (source: RemoteSourceMeta) => {
    setMsg(null);
    try {
      await api.remoteSources.update(source.id, { enabled: !source.enabled });
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t update remote source" });
    }
  };

  const handlePollNow = async (source: RemoteSourceMeta) => {
    setPollingId(source.id);
    setMsg(null);
    try {
      const summary = await api.remoteSources.pollNow(source.id);
      setMsg({
        ok:
          summary.status === "ok" ||
          summary.status === "validation_rejects" ||
          summary.status === "skipped_locked",
        text:
          summary.status === "skipped_locked"
            ? `${source.name}: already being polled by another instance`
            : `${source.name}: ${summary.accepted} accepted, ${summary.rejected} rejected (${summary.status})`,
      });
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Poll failed" });
    } finally {
      setPollingId(null);
    }
  };

  const startEdit = (source: RemoteSourceMeta) => {
    setShowAdd(false);
    setMsg(null);
    setEditingId(source.id);
    setEditName(source.name);
    setEditBaseUrl(source.baseUrl);
    setEditPollInterval(String(source.pollIntervalMinutes));
    setEditRotateAuth(false);
    setEditAuthType(source.authType);
    setEditApiKey("");
    setEditHeaderName("");
    setEditTokenUrl("");
    setEditClientId("");
    setEditClientSecret("");
    setEditScope("");
    setEditScriptBody("");
    setEditEnvText("");
    setEditAcceptLiability(false);
  };

  const cancelEdit = () => setEditingId(null);

  const handleEditSubmit = async (e: React.FormEvent, source: RemoteSourceMeta) => {
    e.preventDefault();
    setEditBusy(true);
    setMsg(null);
    try {
      await api.remoteSources.update(source.id, {
        name: editName,
        baseUrl: editBaseUrl,
        pollIntervalMinutes: Number(editPollInterval) || 15,
        ...(editRotateAuth
          ? {
              auth: buildAuth({
                authType: editAuthType,
                apiKey: editApiKey,
                headerName: editHeaderName,
                tokenUrl: editTokenUrl,
                clientId: editClientId,
                clientSecret: editClientSecret,
                scope: editScope,
                scriptBody: editScriptBody,
                envText: editEnvText,
              }),
            }
          : {}),
      });
      setEditingId(null);
      refresh();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Couldn’t update remote source" });
    } finally {
      setEditBusy(false);
    }
  };

  const smallInput: React.CSSProperties = {
    width: "100%",
    padding: "6px 8px",
    borderRadius: 6,
    border: `1px solid ${C.border}`,
    fontSize: 12,
    fontFamily: SANS,
    outline: "none",
    boxSizing: "border-box",
  };

  const scriptTextarea: React.CSSProperties = {
    width: "100%",
    fontFamily: MONO,
    fontSize: 11.5,
    lineHeight: 1.5,
    padding: 8,
    borderRadius: 6,
    border: `1px solid ${C.border}`,
    background: C.surfaceAlt,
    color: C.ink,
    resize: "vertical",
    outline: "none",
    boxSizing: "border-box",
  };

  // Shared by the add-form and the edit-form's optional "rotate credential" fields.
  const authFields = (fields: {
    authType: RemoteSourceAuthType;
    setAuthType: (v: RemoteSourceAuthType) => void;
    apiKey: string;
    setApiKey: (v: string) => void;
    headerName: string;
    setHeaderName: (v: string) => void;
    tokenUrl: string;
    setTokenUrl: (v: string) => void;
    clientId: string;
    setClientId: (v: string) => void;
    clientSecret: string;
    setClientSecret: (v: string) => void;
    scope: string;
    setScope: (v: string) => void;
    scriptBody: string;
    setScriptBody: (v: string) => void;
    envText: string;
    setEnvText: (v: string) => void;
    acceptLiability: boolean;
    setAcceptLiability: (v: boolean) => void;
  }) => (
    <>
      <select
        value={fields.authType}
        onChange={(e) => fields.setAuthType(e.target.value as RemoteSourceAuthType)}
        style={smallInput}
      >
        <option value="api_key">API key</option>
        <option value="oauth2_client_credentials">OAuth2 client credentials</option>
        <option value="custom">Custom script (Python)</option>
      </select>
      {fields.authType === "api_key" ? (
        <>
          <input
            type="password"
            placeholder="API key"
            value={fields.apiKey}
            onChange={(e) => fields.setApiKey(e.target.value)}
            style={smallInput}
          />
          <input
            placeholder="Header name (default X-API-Key)"
            value={fields.headerName}
            onChange={(e) => fields.setHeaderName(e.target.value)}
            style={smallInput}
          />
        </>
      ) : fields.authType === "oauth2_client_credentials" ? (
        <>
          <input
            placeholder="Token URL"
            value={fields.tokenUrl}
            onChange={(e) => fields.setTokenUrl(e.target.value)}
            style={smallInput}
          />
          <input
            placeholder="Client ID"
            value={fields.clientId}
            onChange={(e) => fields.setClientId(e.target.value)}
            style={smallInput}
          />
          <input
            type="password"
            placeholder="Client secret"
            value={fields.clientSecret}
            onChange={(e) => fields.setClientSecret(e.target.value)}
            style={smallInput}
          />
          <input
            placeholder="Scope (optional)"
            value={fields.scope}
            onChange={(e) => fields.setScope(e.target.value)}
            style={smallInput}
          />
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <div style={{ fontSize: 10.5, color: C.textMuted, flex: 1 }}>
              Script owns the whole pull: connect, scan since <code style={{ fontFamily: MONO }}>WATERMARK</code>{" "}
              (env var), parse, map to CallRecord shape, print{" "}
              <code style={{ fontFamily: MONO }}>{`{"records": [...], "watermark": "..."}`}</code> to stdout, exit 0.
              Runs sandboxed (non-root, timed out, memory- and output-capped) but with real network access.
            </div>
            <button
              type="button"
              onClick={() => setShowExamples(true)}
              style={{
                border: `1px solid ${C.border}`,
                background: C.surface,
                color: C.accentDeep,
                borderRadius: 6,
                padding: "4px 9px",
                fontSize: 11,
                fontWeight: 650,
                cursor: "pointer",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              Example scripts
            </button>
          </div>
          {showExamples && (
            <ExampleScriptsModal
              onUse={(ex) => {
                fields.setScriptBody(ex.scriptBody);
                fields.setEnvText(ex.envHint);
                setShowExamples(false);
              }}
              onClose={() => setShowExamples(false)}
            />
          )}
          <textarea
            placeholder="Python script body"
            value={fields.scriptBody}
            onChange={(e) => fields.setScriptBody(e.target.value)}
            spellCheck={false}
            style={{ ...scriptTextarea, height: 180 }}
          />
          <div style={{ fontSize: 10.5, color: C.textMuted }}>
            Environment variables for the script, one <code style={{ fontFamily: MONO }}>KEY=value</code> per line
            (e.g. SFTP host/user/password) — encrypted at rest, same as the credentials above.
          </div>
          <textarea
            placeholder={"SFTP_HOST=example.com\nSFTP_USER=cdr-export\nSFTP_PASSWORD=..."}
            value={fields.envText}
            onChange={(e) => fields.setEnvText(e.target.value)}
            spellCheck={false}
            style={{ ...scriptTextarea, height: 70 }}
          />
          <div
            style={{
              display: "flex",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 6,
              background: C.roseSoft,
              border: `1px solid ${C.rose}55`,
            }}
          >
            <input
              type="checkbox"
              id="accept-script-liability"
              checked={fields.acceptLiability}
              onChange={(e) => fields.setAcceptLiability(e.target.checked)}
              style={{ marginTop: 2, flexShrink: 0 }}
            />
            <label
              htmlFor="accept-script-liability"
              style={{ fontSize: 11, color: C.rose, lineHeight: 1.4, cursor: "pointer" }}
            >
              This script will execute on this server with real network access every time this source polls. I
              wrote it (or trust whoever did), and I accept full responsibility for what it does — this platform
              runs it as submitted, with only coarse limits (non-root, a timeout, memory/output caps), not a
              security sandbox.
            </label>
          </div>
        </>
      )}
    </>
  );

  return (
    <div style={{ padding: "8px 10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: C.textMuted,
            fontWeight: 700,
          }}
        >
          Remote sources
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setShowAdd((v) => !v);
          }}
          style={{
            border: "none",
            background: "transparent",
            color: C.accentDeep,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 650,
            padding: 0,
          }}
        >
          {showAdd ? "Cancel" : "+ Add source"}
        </button>
      </div>

      {loading ? (
        <div style={{ fontSize: 12.5, color: C.textMuted }}>Loading…</div>
      ) : !sources || sources.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.textMuted }}>No remote sources configured.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 260, overflowY: "auto" }}>
          {sources.map((s) =>
            editingId === s.id ? (
              <form
                key={s.id}
                onSubmit={(e) => handleEditSubmit(e, s)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: "8px 0",
                  borderTop: `1px solid ${C.border}`,
                }}
              >
                <div style={{ fontWeight: 650, fontSize: 12, color: C.ink }}>Editing {s.name}</div>
                <input
                  placeholder="Name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                  style={smallInput}
                />
                <input
                  placeholder="Base URL"
                  value={editBaseUrl}
                  onChange={(e) => setEditBaseUrl(e.target.value)}
                  required
                  style={smallInput}
                />
                <input
                  type="number"
                  min={1}
                  placeholder="Poll interval (minutes)"
                  value={editPollInterval}
                  onChange={(e) => setEditPollInterval(e.target.value)}
                  style={smallInput}
                />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textMid }}>
                  <input
                    type="checkbox"
                    checked={editRotateAuth}
                    onChange={(e) => setEditRotateAuth(e.target.checked)}
                  />
                  Change credential
                </label>
                {editRotateAuth &&
                  authFields({
                    authType: editAuthType,
                    setAuthType: setEditAuthType,
                    apiKey: editApiKey,
                    setApiKey: setEditApiKey,
                    headerName: editHeaderName,
                    setHeaderName: setEditHeaderName,
                    tokenUrl: editTokenUrl,
                    setTokenUrl: setEditTokenUrl,
                    clientId: editClientId,
                    setClientId: setEditClientId,
                    clientSecret: editClientSecret,
                    setClientSecret: setEditClientSecret,
                    scope: editScope,
                    setScope: setEditScope,
                    scriptBody: editScriptBody,
                    setScriptBody: setEditScriptBody,
                    envText: editEnvText,
                    setEnvText: setEditEnvText,
                    acceptLiability: editAcceptLiability,
                    setAcceptLiability: setEditAcceptLiability,
                  })}
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="submit"
                    disabled={editBusy || (editRotateAuth && editAuthType === "custom" && !editAcceptLiability)}
                    style={{
                      flex: 1,
                      padding: "7px 10px",
                      borderRadius: 6,
                      border: "none",
                      background:
                        editBusy || (editRotateAuth && editAuthType === "custom" && !editAcceptLiability)
                          ? C.borderStrong
                          : C.ink,
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 650,
                      cursor:
                        editBusy || (editRotateAuth && editAuthType === "custom" && !editAcceptLiability)
                          ? "default"
                          : "pointer",
                    }}
                  >
                    {editBusy ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    style={{
                      flex: 1,
                      padding: "7px 10px",
                      borderRadius: 6,
                      border: `1px solid ${C.border}`,
                      background: C.surface,
                      color: C.textMid,
                      fontSize: 12,
                      fontWeight: 650,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div key={s.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: C.ink, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={s.baseUrl}
                    >
                      {s.name}
                    </span>
                    {!s.enabled && <span style={{ fontSize: 10.5, color: C.textMuted }}>(disabled)</span>}
                  </div>
                  <div style={{ color: C.textMuted, fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
                    <span>{s.lastPolledAt ? `last polled ${fmtRelative(s.lastPolledAt)}` : "never polled"}</span>
                    <span
                      style={{
                        padding: "1px 5px",
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 650,
                        background: pollStatusStyle(s.lastPollStatus).bg,
                        color: pollStatusStyle(s.lastPollStatus).fg,
                      }}
                    >
                      {pollStatusStyle(s.lastPollStatus).label}
                    </span>
                  </div>
                  {s.rejectCount > 0 && (
                    <button
                      onClick={() => setRejectsSource(s)}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: C.rose,
                        fontSize: 11,
                        padding: 0,
                        cursor: "pointer",
                      }}
                    >
                      {s.rejectCount} reject{s.rejectCount === 1 ? "" : "s"} →
                    </button>
                  )}
                </div>
                <button
                  onClick={() => handlePollNow(s)}
                  disabled={pollingId === s.id}
                  title="Poll now"
                  style={{
                    border: "none",
                    background: "transparent",
                    color: C.accentDeep,
                    cursor: pollingId === s.id ? "default" : "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                    padding: "1px 3px",
                  }}
                >
                  {pollingId === s.id ? "Polling…" : "Poll now"}
                </button>
                <button
                  onClick={() => handleToggleEnabled(s)}
                  title={s.enabled ? "Disable" : "Enable"}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: C.textMid,
                    cursor: "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                    padding: "1px 3px",
                  }}
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => startEdit(s)}
                  title={`Edit ${s.name}`}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: C.accentDeep,
                    cursor: "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                    padding: "1px 3px",
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(s)}
                  title={`Delete ${s.name}`}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: C.rose,
                    cursor: "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                    padding: "1px 3px",
                  }}
                >
                  Delete
                </button>
              </div>
            )
          )}
        </div>
      )}

      {showAdd && (
        <form onSubmit={handleAdd} style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            placeholder="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            style={smallInput}
          />
          <input
            placeholder={
              newAuthType === "custom"
                ? "Base URL — not used by a script; any valid URL is fine as a label, e.g. https://cucm.internal.example"
                : "Base URL (e.g. https://other-instance.example.com/api/cdr/v1)"
            }
            value={newBaseUrl}
            onChange={(e) => setNewBaseUrl(e.target.value)}
            required
            style={smallInput}
          />
          <input
            type="number"
            min={1}
            placeholder="Poll interval (minutes)"
            value={newPollInterval}
            onChange={(e) => setNewPollInterval(e.target.value)}
            style={smallInput}
          />
          <label style={{ fontSize: 11, color: C.textMuted }}>
            Backfill from
            <input
              type="datetime-local"
              value={newBackfillFrom}
              onChange={(e) => setNewBackfillFrom(e.target.value)}
              required
              style={{ ...smallInput, marginTop: 2 }}
            />
          </label>
          {authFields({
            authType: newAuthType,
            setAuthType: setNewAuthType,
            apiKey: newApiKey,
            setApiKey: setNewApiKey,
            headerName: newHeaderName,
            setHeaderName: setNewHeaderName,
            tokenUrl: newTokenUrl,
            setTokenUrl: setNewTokenUrl,
            clientId: newClientId,
            setClientId: setNewClientId,
            clientSecret: newClientSecret,
            setClientSecret: setNewClientSecret,
            scope: newScope,
            setScope: setNewScope,
            scriptBody: newScriptBody,
            setScriptBody: setNewScriptBody,
            envText: newEnvText,
            setEnvText: setNewEnvText,
            acceptLiability: newAcceptLiability,
            setAcceptLiability: setNewAcceptLiability,
          })}
          <button
            type="submit"
            disabled={busy || (newAuthType === "custom" && !newAcceptLiability)}
            style={{
              padding: "7px 10px",
              borderRadius: 6,
              border: "none",
              background: busy || (newAuthType === "custom" && !newAcceptLiability) ? C.borderStrong : C.ink,
              color: "#fff",
              fontSize: 12,
              fontWeight: 650,
              cursor: busy || (newAuthType === "custom" && !newAcceptLiability) ? "default" : "pointer",
            }}
          >
            {busy ? "Creating…" : "Create source"}
          </button>
        </form>
      )}

      {msg && (
        <div
          style={{
            marginTop: 8,
            padding: "6px 8px",
            borderRadius: 6,
            fontSize: 11.5,
            background: msg.ok ? C.tealSoft : C.roseSoft,
            color: msg.ok ? C.teal : C.rose,
          }}
        >
          {msg.text}
        </div>
      )}

      {rejectsSource && (
        <RemoteSourceRejectsModal
          sourceId={rejectsSource.id}
          sourceName={rejectsSource.name}
          onClose={() => setRejectsSource(null)}
        />
      )}
    </div>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────────
function FilterBar(props: {
  startTime: string;
  endTime: string;
  datePreset: string;
  mediaType: string;
  groups: string;
  sourcePlatformId: string;
  participant: string;
  queue: string;
  ivr: string;
  advanced: string;
  callIdQuery: string;
  callIdError: string | null;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  onPresetChange: (v: string) => void;
  onMedia: (v: string) => void;
  onGroups: (v: string) => void;
  onSourcePlatformId: (v: string) => void;
  onParticipant: (v: string) => void;
  onQueue: (v: string) => void;
  onIvr: (v: string) => void;
  onAdvanced: (v: string) => void;
  onCallIdQueryChange: (v: string) => void;
  onLookupCallId: () => Promise<boolean>;
  onApply: () => void;
  onClear: () => void;
  showExport: boolean;
  exporting: boolean;
  onExport: (format: "csv" | "json") => void;
}) {
  const [showMore, setShowMore] = useState(false);
  const activeCount = [
    props.groups,
    props.sourcePlatformId,
    props.participant,
    props.queue,
    props.ivr,
    props.advanced,
  ].filter((v) => v.trim().length > 0).length;
  const inputStyle: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.surface,
    fontSize: 13,
    color: C.ink,
    fontFamily: SANS,
    outline: "none",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.textMuted,
    fontWeight: 700,
    marginBottom: 4,
    display: "block",
  };
  return (
    <div
      style={{
        display: "flex",
        gap: 14,
        flexWrap: "wrap",
        alignItems: "flex-end",
        padding: "18px 0 6px",
      }}
    >
      <div>
        <label style={labelStyle}>Range</label>
        <select
          value={props.datePreset}
          onChange={(e) => props.onPresetChange(e.target.value)}
          style={{ ...inputStyle, minWidth: 140 }}
        >
          {DATE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label style={labelStyle}>From (UTC window)</label>
        <input
          type="datetime-local"
          value={isoToLocalInput(props.startTime)}
          onChange={(e) => props.onStart(localInputToIso(e.target.value))}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>To</label>
        <input
          type="datetime-local"
          value={isoToLocalInput(props.endTime)}
          onChange={(e) => props.onEnd(localInputToIso(e.target.value))}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Media type</label>
        <select
          value={props.mediaType}
          onChange={(e) => props.onMedia(e.target.value)}
          style={{ ...inputStyle, minWidth: 130 }}
        >
          <option value="">All media</option>
          <option value="voice">Voice</option>
          <option value="video">Video</option>
          <option value="chat">Chat</option>
          <option value="instant_message">Instant message</option>
          <option value="email">Email</option>
        </select>
      </div>
      <div style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: 6 }}>
        <div>
          <label style={labelStyle}>&nbsp;</label>
          <button
            onClick={() => setShowMore((v) => !v)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 14px",
              borderRadius: 8,
              border: `1px solid ${activeCount ? C.accent : C.border}`,
              background: activeCount ? C.accentSoft : C.surface,
              color: activeCount ? C.accentDeep : C.ink,
              fontSize: 13,
              fontWeight: 650,
              cursor: "pointer",
            }}
          >
            ⚙ Filters
            {activeCount > 0 && (
              <span
                style={{
                  display: "inline-grid",
                  placeItems: "center",
                  minWidth: 17,
                  height: 17,
                  padding: "0 4px",
                  borderRadius: 999,
                  background: C.accent,
                  color: "#fff",
                  fontSize: 10.5,
                  fontWeight: 700,
                }}
              >
                {activeCount}
              </span>
            )}
          </button>
        </div>

        {activeCount > 0 && (
          <button
            onClick={() => {
              props.onClear();
              setShowMore(false);
            }}
            title="Clear filters"
            aria-label="Clear filters"
            style={{
              width: 34,
              height: 34,
              display: "inline-grid",
              placeItems: "center",
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.surface,
              color: C.textMid,
              fontSize: 15,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        )}

        {showMore && (
          <>
            <div
              onClick={() => setShowMore(false)}
              style={{ position: "fixed", inset: 0, zIndex: 29 }}
            />
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                zIndex: 30,
                width: 320,
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 12,
                boxShadow: "0 14px 34px rgba(15,22,32,0.16)",
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div style={{ paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
                <label style={labelStyle}>Call ID (jump to record)</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="text"
                    placeholder="Jump to a known call ID"
                    value={props.callIdQuery}
                    onChange={(e) => props.onCallIdQueryChange(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (await props.onLookupCallId()) setShowMore(false);
                      }
                    }}
                    style={{ ...inputStyle, width: "100%" }}
                  />
                  <button
                    onClick={async () => {
                      if (await props.onLookupCallId()) setShowMore(false);
                    }}
                    disabled={!props.callIdQuery.trim()}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: `1px solid ${C.border}`,
                      background: C.surface,
                      color: C.ink,
                      fontSize: 13,
                      fontWeight: 650,
                      cursor: props.callIdQuery.trim() ? "pointer" : "default",
                      opacity: props.callIdQuery.trim() ? 1 : 0.5,
                    }}
                  >
                    Open
                  </button>
                </div>
                {props.callIdError && (
                  <div style={{ fontSize: 11, color: C.rose, marginTop: 4 }}>{props.callIdError}</div>
                )}
              </div>
              <div>
                <label style={labelStyle}>Groups (comma-separated)</label>
                <input
                  type="text"
                  placeholder="trading-floor-london, compliance-group-1"
                  value={props.groups}
                  onChange={(e) => props.onGroups(e.target.value)}
                  style={{ ...inputStyle, width: "100%" }}
                />
              </div>
              <div>
                <label style={labelStyle}>Source platforms (comma-separated)</label>
                <input
                  type="text"
                  placeholder="switch-lon-01, switch-nyc-02"
                  value={props.sourcePlatformId}
                  onChange={(e) => props.onSourcePlatformId(e.target.value)}
                  style={{ ...inputStyle, width: "100%" }}
                />
              </div>
              <div>
                <label style={labelStyle}>Participant</label>
                <input
                  type="text"
                  placeholder="name, user ID, or extension"
                  value={props.participant}
                  onChange={(e) => props.onParticipant(e.target.value)}
                  style={{ ...inputStyle, width: "100%" }}
                />
              </div>
              <div>
                <label style={labelStyle}>Queue (comma-separated)</label>
                <input
                  type="text"
                  placeholder="support-queue-nyc, billing-queue-nyc"
                  value={props.queue}
                  onChange={(e) => props.onQueue(e.target.value)}
                  style={{ ...inputStyle, width: "100%" }}
                />
              </div>
              <div>
                <label style={labelStyle}>IVR (comma-separated)</label>
                <input
                  type="text"
                  placeholder="main-ivr, billing-ivr"
                  value={props.ivr}
                  onChange={(e) => props.onIvr(e.target.value)}
                  style={{ ...inputStyle, width: "100%" }}
                />
              </div>
              <div>
                <label style={labelStyle}>Advanced (comma-separated)</label>
                <input
                  type="text"
                  placeholder="mos < 3, jitter > 50"
                  value={props.advanced}
                  onChange={(e) => props.onAdvanced(e.target.value)}
                  style={{ ...inputStyle, width: "100%", fontFamily: MONO }}
                />
                <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 4 }}>
                  Fields: mos, jitter, latency, packetLoss, duration, ivrTime, queueTime · operators: &lt; &lt;= &gt; &gt;= = !=
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => {
                    props.onApply();
                    setShowMore(false);
                  }}
                  style={{
                    flex: 1,
                    padding: "9px 14px",
                    borderRadius: 8,
                    border: "none",
                    background: C.ink,
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 650,
                    cursor: "pointer",
                  }}
                >
                  Apply filters
                </button>
                {activeCount > 0 && (
                  <button
                    onClick={() => {
                      props.onClear();
                      setShowMore(false);
                    }}
                    style={{
                      padding: "9px 14px",
                      borderRadius: 8,
                      border: `1px solid ${C.border}`,
                      background: C.surface,
                      color: C.textMid,
                      fontSize: 13,
                      fontWeight: 650,
                      cursor: "pointer",
                    }}
                  >
                    Clear all
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <button
        onClick={props.onApply}
        style={{
          padding: "9px 18px",
          borderRadius: 8,
          border: "none",
          background: C.ink,
          color: "#fff",
          fontSize: 13,
          fontWeight: 650,
          cursor: "pointer",
        }}
      >
        Apply
      </button>

      {props.showExport && (
        <div style={{ marginLeft: "auto" }}>
          <ExportMenu busy={props.exporting} onExport={props.onExport} />
        </div>
      )}
    </div>
  );
}

// ─── Stat strip ───────────────────────────────────────────────────────────────
function StatStrip({ stats, total }: { stats: StatisticsSummary; total: number }) {
  const v = stats.voiceBreakdown;
  const cells: { label: string; value: string; sub?: string; fg?: string }[] = [
    { label: "Records in window", value: String(total) },
    {
      label: "Answered (voice)",
      value: String(v.maturedAnswered),
      fg: C.teal,
    },
    {
      label: "Unanswered (voice)",
      value: String(v.unmaturedUnanswered),
      fg: C.rose,
    },
    {
      label: "Avg time in queue",
      value: fmtDur(stats.averageDurations.avgTimeInQueueSeconds),
    },
    {
      label: "Avg talk time",
      value: fmtDur(stats.averageDurations.avgTimeWithAgentSeconds),
    },
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(150px, 1fr))`,
        gap: 12,
        margin: "8px 0 4px",
      }}
    >
      {cells.map((c) => (
        <div
          key={c.label}
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: "14px 16px",
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: C.textMuted,
              fontWeight: 700,
            }}
          >
            {c.label}
          </div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 700,
              marginTop: 4,
              color: c.fg ?? C.ink,
              fontFamily: MONO,
              letterSpacing: -0.5,
            }}
          >
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Insights: throughput + top talkers ────────────────────────────────────────
function InsightsPanel({
  throughput,
  throughputByOutcome,
  platformBreakdown,
  handleTimeTrend,
  agentHandleTime,
  queueWaitTrend,
  queueWaitBreakdown,
  worstMosCalls,
  ivrTimeTrend,
  ivrTimeByIvr,
  talkersInternal,
  talkersExternal,
  talkersTab,
  onTalkersTabChange,
  onSelectTalker,
  onSelectQueue,
  onSelectIvr,
  onOpenCall,
}: {
  throughput: ThroughputPoint[];
  throughputByOutcome: ThroughputOutcomePoint[];
  platformBreakdown: PlatformBreakdownPoint[];
  handleTimeTrend: HandleTimeTrendPoint[];
  agentHandleTime: AgentHandleTime[];
  queueWaitTrend: QueueWaitTrendPoint[];
  queueWaitBreakdown: QueueWaitBreakdown[];
  worstMosCalls: WorstMosCall[];
  ivrTimeTrend: IvrTimeTrendPoint[];
  ivrTimeByIvr: IvrBreakdown[];
  talkersInternal: TopTalker[];
  talkersExternal: TopTalker[];
  talkersTab: "internal" | "external";
  onTalkersTabChange: (tab: "internal" | "external") => void;
  onSelectTalker: (identity: string) => void;
  onSelectQueue: (queueId: string) => void;
  onSelectIvr: (ivrId: string) => void;
  onOpenCall: (callId: string) => void;
}) {
  const activeTalkers = talkersTab === "internal" ? talkersInternal : talkersExternal;
  return (
    <div style={{ display: "flex", gap: 12, margin: "16px 0 4px", flexWrap: "wrap" }}>
      {throughput.length > 0 && (
        <ThroughputCard
          throughput={throughput}
          throughputByOutcome={throughputByOutcome}
          platformBreakdown={platformBreakdown}
          handleTimeTrend={handleTimeTrend}
          agentHandleTime={agentHandleTime}
          queueWaitTrend={queueWaitTrend}
          queueWaitBreakdown={queueWaitBreakdown}
          worstMosCalls={worstMosCalls}
          ivrTimeTrend={ivrTimeTrend}
          ivrTimeByIvr={ivrTimeByIvr}
          onSelectAgent={onSelectTalker}
          onSelectQueue={onSelectQueue}
          onSelectIvr={onSelectIvr}
          onOpenCall={onOpenCall}
        />
      )}
      {(talkersInternal.length > 0 || talkersExternal.length > 0) && (
        <div
          style={{
            flex: "1 1 280px",
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: "14px 16px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: C.textMuted,
                fontWeight: 700,
              }}
            >
              Top talkers
            </div>
            <div
              style={{
                display: "flex",
                gap: 2,
                background: C.surfaceAlt,
                borderRadius: 8,
                padding: 2,
              }}
            >
              {(["internal", "external"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => onTalkersTabChange(tab)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 6,
                    border: "none",
                    background: talkersTab === tab ? C.surface : "transparent",
                    color: talkersTab === tab ? C.ink : C.textMuted,
                    fontSize: 11.5,
                    fontWeight: 650,
                    cursor: "pointer",
                    boxShadow: talkersTab === tab ? "0 1px 2px rgba(15,22,32,0.08)" : "none",
                  }}
                >
                  {tab === "internal" ? "Internal" : "External"}
                </button>
              ))}
            </div>
          </div>
          {activeTalkers.length > 0 ? (
            <TopTalkersTable talkers={activeTalkers} onSelect={onSelectTalker} />
          ) : (
            <div style={{ fontSize: 12.5, color: C.textMuted, padding: "10px 0" }}>
              No {talkersTab} talkers in this window.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Single-series magnitude-over-time → sequential single hue (the app's accent),
// no legend (the chart's own title names the one series). Bars: ≤24px thick,
// 4px rounded data-end, 2px surface gap, hover tooltip per bar. Shared by
// throughput, handle time, and queue wait — only title/value formatting differ.
function TrendBarChart({
  title,
  data,
  formatValue,
  height = 120,
}: {
  title: string;
  data: { bucketStart: string; value: number }[];
  formatValue: (v: number) => string;
  height?: number;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (data.length === 0) return null;

  const max = Math.max(...data.map((d) => d.value), 1);
  const isHourly =
    data.length > 1 &&
    new Date(data[1].bucketStart).getTime() - new Date(data[0].bucketStart).getTime() <
      25 * 3_600_000;

  const fmtBucket = (iso: string) =>
    isHourly
      ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

  // Sparse x labels (first / middle / last) — never one per bar.
  const labelIdxs = new Set<number>([0, data.length - 1]);
  if (data.length > 2) labelIdxs.add(Math.floor((data.length - 1) / 2));

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: C.textMuted,
            fontWeight: 700,
          }}
        >
          {title}
        </span>
        <span style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>
          max {formatValue(max)} / {isHourly ? "hour" : "day"}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          height,
          gap: 2,
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        {data.map((d, i) => {
          const h = Math.max(2, Math.round((d.value / max) * (height - 6)));
          const hovered = hoverIdx === i;
          return (
            <div
              key={d.bucketStart}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx((v) => (v === i ? null : v))}
              style={{
                flex: 1,
                display: "flex",
                justifyContent: "center",
                height: "100%",
                alignItems: "flex-end",
                position: "relative",
              }}
            >
              <div
                style={{
                  width: "100%",
                  maxWidth: 24,
                  height: h,
                  background: hovered ? C.accentDeep : C.accent,
                  borderRadius: "4px 4px 0 0",
                }}
              />
              {hovered && (
                <div
                  style={{
                    position: "absolute",
                    bottom: h + 8,
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: C.ink,
                    color: "#fff",
                    fontSize: 11.5,
                    padding: "5px 9px",
                    borderRadius: 6,
                    whiteSpace: "nowrap",
                    zIndex: 5,
                    pointerEvents: "none",
                  }}
                >
                  <strong style={{ fontFamily: MONO }}>{formatValue(d.value)}</strong>{" "}
                  <span style={{ opacity: 0.85 }}>{fmtBucket(d.bucketStart)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex" }}>
        {data.map((d, i) => (
          <div
            key={d.bucketStart}
            style={{
              flex: 1,
              textAlign: "center",
              fontSize: 10.5,
              color: C.textMuted,
              fontFamily: MONO,
              marginTop: 6,
            }}
          >
            {labelIdxs.has(i) ? fmtBucket(d.bucketStart) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

// Two-category comparison (not single-series magnitude) → categorical color,
// not sequential: accent (answered) + rose (unanswered), reusing rose's
// existing meaning elsewhere in this app (missed/abandoned state pills), and
// validated as a categorical pair (validate_palette.js, adjacent — the only
// check that applies since a stack only ever has these two touching). Legend
// is mandatory at 2+ series, shown inline in the header since there are only two.
function ThroughputOutcomeChart({
  data,
  height = 120,
}: {
  data: { bucketStart: string; answered: number; unanswered: number }[];
  height?: number;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (data.length === 0) return null;

  const totals = data.map((d) => d.answered + d.unanswered);
  const max = Math.max(...totals, 1);
  const isHourly =
    data.length > 1 &&
    new Date(data[1].bucketStart).getTime() - new Date(data[0].bucketStart).getTime() <
      25 * 3_600_000;

  const fmtBucket = (iso: string) =>
    isHourly
      ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

  const labelIdxs = new Set<number>([0, data.length - 1]);
  if (data.length > 2) labelIdxs.add(Math.floor((data.length - 1) / 2));

  const legendDot = (color: string, label: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: color }} />
      <span style={{ color: C.textMid }}>{label}</span>
    </span>
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: C.textMuted,
            fontWeight: 700,
          }}
        >
          Calls throughput
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11.5 }}>
          {legendDot(C.accent, "Answered")}
          {legendDot(C.rose, "Unanswered")}
          <span style={{ color: C.textMuted, fontFamily: MONO }}>
            max {max} / {isHourly ? "hour" : "day"}
          </span>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          height,
          gap: 2,
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        {data.map((d, i) => {
          const hAnswered = Math.max(0, Math.round((d.answered / max) * (height - 6)));
          const hUnanswered = Math.max(0, Math.round((d.unanswered / max) * (height - 6)));
          const hovered = hoverIdx === i;
          const total = d.answered + d.unanswered;
          return (
            <div
              key={d.bucketStart}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx((v) => (v === i ? null : v))}
              style={{
                flex: 1,
                display: "flex",
                justifyContent: "center",
                height: "100%",
                alignItems: "flex-end",
                position: "relative",
                opacity: hoverIdx !== null && !hovered ? 0.55 : 1,
              }}
            >
              <div style={{ width: "100%", maxWidth: 24, display: "flex", flexDirection: "column" }}>
                {hUnanswered > 0 && (
                  <div
                    style={{
                      height: hUnanswered,
                      background: C.rose,
                      borderRadius: hAnswered > 0 ? "4px 4px 0 0" : "4px 4px 0 0",
                    }}
                  />
                )}
                {hUnanswered > 0 && hAnswered > 0 && (
                  <div style={{ height: 2, background: C.surface }} />
                )}
                {hAnswered > 0 && (
                  <div
                    style={{
                      height: hAnswered,
                      background: C.accent,
                      borderRadius: hUnanswered > 0 ? "0 0 0 0" : "4px 4px 0 0",
                    }}
                  />
                )}
              </div>
              {hovered && (
                <div
                  style={{
                    position: "absolute",
                    bottom: hAnswered + hUnanswered + 8,
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: C.ink,
                    color: "#fff",
                    fontSize: 11.5,
                    padding: "6px 10px",
                    borderRadius: 6,
                    whiteSpace: "nowrap",
                    zIndex: 5,
                    pointerEvents: "none",
                  }}
                >
                  <div>
                    <strong style={{ fontFamily: MONO }}>{total}</strong>{" "}
                    <span style={{ opacity: 0.85 }}>{fmtBucket(d.bucketStart)}</span>
                  </div>
                  <div style={{ opacity: 0.85, marginTop: 2 }}>
                    {d.answered} answered · {d.unanswered} unanswered
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex" }}>
        {data.map((d, i) => (
          <div
            key={d.bucketStart}
            style={{
              flex: 1,
              textAlign: "center",
              fontSize: 10.5,
              color: C.textMuted,
              fontFamily: MONO,
              marginTop: 6,
            }}
          >
            {labelIdxs.has(i) ? fmtBucket(d.bucketStart) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

// Fixed categorical order for real source platforms. Reuses the app's
// accent/teal/amber/rose, but swaps violet for a magenta: violet fails CVD
// separation against the accent blue once *any* two segments can be adjacent
// (validated with validate_palette.js --pairs all) — true for a donut's
// data-ordered arcs, unlike a fixed-sequence bar chart where only neighbors matter.
const PLATFORM_COLORS = [C.accent, C.teal, C.amber, C.rose, "#A63A9E"];
const PLATFORM_OTHER_COLOR = C.textMid; // folded tail, >5 distinct real platforms
const PLATFORM_UNKNOWN_COLOR = C.textMuted; // records with no sourcePlatformId

interface PieSlice {
  key: string;
  label: string;
  count: number;
  color: string;
}

function buildPlatformSlices(data: PlatformBreakdownPoint[]): PieSlice[] {
  const real = data
    .filter((d): d is { sourcePlatformId: string; count: number } => !!d.sourcePlatformId)
    // Identity-stable order (alphabetical, not by count) so a given platform
    // keeps its color across filter/window changes rather than repainting on rank.
    .sort((a, b) => a.sourcePlatformId.localeCompare(b.sourcePlatformId));
  const unknownCount = data
    .filter((d) => !d.sourcePlatformId)
    .reduce((s, d) => s + d.count, 0);

  const slices: PieSlice[] = real.slice(0, PLATFORM_COLORS.length).map((p, i) => ({
    key: p.sourcePlatformId,
    label: p.sourcePlatformId,
    count: p.count,
    color: PLATFORM_COLORS[i],
  }));

  const overflow = real.slice(PLATFORM_COLORS.length);
  if (overflow.length > 0) {
    slices.push({
      key: "__other",
      label: `Other (${overflow.length})`,
      count: overflow.reduce((s, p) => s + p.count, 0),
      color: PLATFORM_OTHER_COLOR,
    });
  }

  if (unknownCount > 0) {
    slices.push({
      key: "__unknown",
      label: "Unknown platform",
      count: unknownCount,
      color: PLATFORM_UNKNOWN_COLOR,
    });
  }

  // Visual (largest-first) draw order only — color already comes from the
  // identity-stable assignment above, so re-sorting here never repaints a slice.
  return slices.sort((a, b) => b.count - a.count);
}

// Part-to-whole, ≤6 segments, "at a glance" — the one case this design system's
// anti-pattern guidance allows a pie (not for comparing close values; exact
// figures ride the hover legend line, not the wedge angles).
function PlatformPie({ data, size }: { data: PlatformBreakdownPoint[]; size: number }) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const slices = buildPlatformSlices(data);
  const total = slices.reduce((s, d) => s + d.count, 0);
  if (total === 0) return null;

  // Fixed pixel size rather than a %-fill/flex chain — nested percentage
  // heights inside nested flex containers proved unreliable in practice
  // (ballooned the card far past the pie's own size). A literal width/height
  // on the <svg> with a 100-unit viewBox is simple and always correct.
  const r = 45;
  const gapDeg = 1.5; // degrees reserved as a surface-color gap between wedges

  let cursorDeg = 0;
  const arcs = slices.map((s) => {
    const rawDeg = (s.count / total) * 360;
    const start = cursorDeg;
    cursorDeg += rawDeg;
    return { ...s, startAngle: start + gapDeg / 2, endAngle: cursorDeg - gapDeg / 2 };
  });

  const hovered = arcs.find((a) => a.key === hoverKey) ?? null;

  const polar = (angleDeg: number) => {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: 50 + r * Math.cos(rad), y: 50 + r * Math.sin(rad) };
  };
  const wedgePath = (startAngle: number, endAngle: number) => {
    const p1 = polar(startAngle);
    const p2 = polar(endAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    return `M 50 50 L ${p1.x} ${p1.y} A ${r} ${r} 0 ${largeArc} 1 ${p2.x} ${p2.y} Z`;
  };

  // No permanent legend — identity rides the hover interaction: a single line
  // below the pie names the hovered wedge, appearing only on mouseover, with a
  // fixed-height reserved slot so the chart doesn't jump when it shows/hides.
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div
        style={{
          fontSize: 10.5,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: C.textMuted,
          fontWeight: 700,
          marginBottom: 12,
          alignSelf: "flex-start",
        }}
      >
        Calls by source platform
      </div>
      <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block" }}>
        {arcs.map((a) => (
          <path
            key={a.key}
            d={wedgePath(a.startAngle, a.endAngle)}
            fill={a.color}
            opacity={hoverKey && hoverKey !== a.key ? 0.45 : 1}
            onMouseEnter={() => setHoverKey(a.key)}
            onMouseLeave={() => setHoverKey((k) => (k === a.key ? null : k))}
            style={{ transition: "opacity 0.12s" }}
          />
        ))}
      </svg>
      <div
        style={{
          height: 22,
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          fontSize: 12.5,
        }}
      >
        {hovered ? (
          <>
            <span
              style={{ width: 9, height: 9, borderRadius: 2, background: hovered.color, flexShrink: 0 }}
            />
            <span
              style={{
                fontWeight: 650,
                color: C.ink,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {hovered.label}
            </span>
            <span style={{ color: C.textMuted, fontFamily: MONO, flexShrink: 0 }}>
              {hovered.count} · {Math.round((hovered.count / total) * 100)}%
            </span>
          </>
        ) : (
          <span style={{ color: C.textMuted, fontFamily: MONO }}>{total} calls — hover a slice</span>
        )}
      </div>
    </div>
  );
}

// Ranked table (not a chart — a handful of ranked classes reads better as a
// table). Call count carries a direct-labeled magnitude wash in the accent hue
// so relative scale reads at a glance without a second chart.
function TopTalkersTable({
  talkers,
  onSelect,
}: {
  talkers: TopTalker[];
  onSelect: (identity: string) => void;
}) {
  const max = Math.max(...talkers.map((t) => t.callCount), 1);
  const head: React.CSSProperties = {
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.textMuted,
    fontWeight: 700,
    textAlign: "left",
    padding: "0 0 8px",
  };
  const cell: React.CSSProperties = {
    padding: "7px 0",
    fontSize: 13,
    borderTop: `1px solid ${C.border}`,
  };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={head}>Talker</th>
          <th style={{ ...head, textAlign: "right" }}>Calls</th>
          <th style={{ ...head, textAlign: "right" }}>Talk time</th>
        </tr>
      </thead>
      <tbody>
        {talkers.map((t) => (
          <tr
            key={t.identity}
            onClick={() => onSelect(t.identity)}
            title={`Show ${t.displayName ?? t.identity}'s calls`}
            style={{ cursor: "pointer" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = C.surfaceAlt;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <td style={cell}>
              <div style={{ fontWeight: 600 }}>{t.displayName ?? t.identity}</div>
              {t.displayName && (
                <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>
                  {t.identity}
                </div>
              )}
            </td>
            <td style={{ ...cell, textAlign: "right", position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: "50%",
                  transform: "translateY(-50%)",
                  height: 18,
                  width: `${Math.max(10, (t.callCount / max) * 100)}%`,
                  background: C.accentSoft,
                  borderRadius: 4,
                }}
              />
              <span
                style={{
                  position: "relative",
                  fontFamily: MONO,
                  fontWeight: 650,
                  paddingRight: 6,
                }}
              >
                {t.callCount}
              </span>
            </td>
            <td style={{ ...cell, textAlign: "right", fontFamily: MONO, color: C.textMid }}>
              {fmtDur(t.totalDurationSeconds)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Ranked table shared by Agent handle time and Queue wait time — same shape as
// TopTalkersTable but the magnitude wash rides the avg-time column, since that's
// what these two are ranked by (longest first), not call count.
function RankedTimeTable({
  nameHeader,
  rows,
  onSelect,
}: {
  nameHeader: string;
  rows: { key: string; label: string; sublabel?: string; count: number; avgSeconds: number }[];
  onSelect?: (key: string) => void;
}) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.avgSeconds), 1);
  const head: React.CSSProperties = {
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.textMuted,
    fontWeight: 700,
    textAlign: "left",
    padding: "0 0 8px",
  };
  const cell: React.CSSProperties = {
    padding: "7px 0",
    fontSize: 13,
    borderTop: `1px solid ${C.border}`,
  };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={head}>{nameHeader}</th>
          <th style={{ ...head, textAlign: "right" }}>Calls</th>
          <th style={{ ...head, textAlign: "right" }}>Avg time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.key}
            onClick={onSelect ? () => onSelect(r.key) : undefined}
            title={onSelect ? `Show ${r.label}'s calls` : undefined}
            style={onSelect ? { cursor: "pointer" } : undefined}
            onMouseEnter={
              onSelect
                ? (e) => {
                    e.currentTarget.style.background = C.surfaceAlt;
                  }
                : undefined
            }
            onMouseLeave={
              onSelect
                ? (e) => {
                    e.currentTarget.style.background = "transparent";
                  }
                : undefined
            }
          >
            <td style={cell}>
              <div style={{ fontWeight: 600 }}>{r.label}</div>
              {r.sublabel && (
                <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>
                  {r.sublabel}
                </div>
              )}
            </td>
            <td style={{ ...cell, textAlign: "right", fontFamily: MONO, color: C.textMid }}>
              {r.count}
            </td>
            <td style={{ ...cell, textAlign: "right", position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: "50%",
                  transform: "translateY(-50%)",
                  height: 18,
                  width: `${Math.max(10, (r.avgSeconds / max) * 100)}%`,
                  background: C.accentSoft,
                  borderRadius: 4,
                }}
              />
              <span
                style={{
                  position: "relative",
                  fontFamily: MONO,
                  fontWeight: 650,
                  paddingRight: 6,
                }}
              >
                {fmtDur(r.avgSeconds)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// MOS (Mean Opinion Score) runs roughly 1–5 for voice quality; these bands
// match ITU-T-ish convention (poor / fair / good) and reuse the app's existing
// state colors (rose = bad, amber = warning, teal = good) rather than
// introducing a new color meaning.
function mosStyle(score: number): { fg: string; bg: string } {
  if (score < 3) return { fg: C.rose, bg: C.roseSoft };
  if (score < 4) return { fg: C.amber, bg: C.amberSoft };
  return { fg: C.teal, bg: C.tealSoft };
}

// Ranked table for the Worst MOS tab — each row is one specific call (unlike
// RankedTimeTable's per-entity aggregates), so clicking opens that call's own
// detail drawer directly instead of filtering the records table.
function WorstMosTable({
  calls,
  onSelect,
}: {
  calls: WorstMosCall[];
  onSelect: (callId: string) => void;
}) {
  if (calls.length === 0) return null;
  const head: React.CSSProperties = {
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.textMuted,
    fontWeight: 700,
    textAlign: "left",
    padding: "0 0 8px",
  };
  const cell: React.CSSProperties = {
    padding: "7px 0",
    fontSize: 13,
    borderTop: `1px solid ${C.border}`,
  };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={head}>Call</th>
          <th style={{ ...head, textAlign: "right" }}>MOS</th>
          <th style={{ ...head, textAlign: "right" }}>Duration</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c) => {
          const st = mosStyle(c.mosScore);
          return (
            <tr
              key={c.callId}
              onClick={() => onSelect(c.callId)}
              title={`Open ${c.callId}`}
              style={{ cursor: "pointer" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = C.surfaceAlt;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <td style={cell}>
                <div style={{ fontWeight: 600, fontFamily: MONO, fontSize: 12.5 }}>
                  {c.callId}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{fmt(c.startTime)}</div>
              </td>
              <td style={{ ...cell, textAlign: "right" }}>
                <Pill fg={st.fg} bg={st.bg}>
                  {c.mosScore.toFixed(1)}
                </Pill>
              </td>
              <td style={{ ...cell, textAlign: "right", fontFamily: MONO, color: C.textMid }}>
                {c.durationSeconds != null ? fmtDur(c.durationSeconds) : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Full-screen overlay for a larger chart view — same treatment as the record
// detail drawer and ingest modal (the app's two existing overlay patterns).
// Export-to-PDF rides the browser's own print pipeline (every browser already
// offers "Save as PDF" as a print destination) rather than a client-side PDF
// library — zero new dependencies, consistent with how this app hand-rolls
// everything else. The print stylesheet hides the rest of the page and lets
// only #chart-print-area through, so the saved PDF is just the chart.
function ExpandModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,22,32,0.4)",
        zIndex: 60,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #chart-print-area, #chart-print-area * { visibility: visible; }
          #chart-print-area {
            position: absolute; left: 0; top: 0; width: 100%;
            box-shadow: none !important; max-height: none !important; overflow: visible !important;
          }
          #chart-print-hide { display: none !important; }
          .print-title { display: block !important; }
        }
      `}</style>
      <div
        id="chart-print-area"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(900px, 95vw)",
          maxHeight: "85vh",
          overflowY: "auto",
          background: C.surface,
          borderRadius: 14,
          boxShadow: "0 24px 60px rgba(15,22,32,0.3)",
        }}
      >
        <div
          id="chart-print-hide"
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            position: "sticky",
            top: 0,
            background: C.surface,
            zIndex: 1,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
          <button
            onClick={() => window.print()}
            style={{
              marginLeft: "auto",
              padding: "6px 12px",
              borderRadius: 7,
              border: `1px solid ${C.border}`,
              background: C.surface,
              color: C.textMid,
              fontSize: 12.5,
              fontWeight: 650,
              cursor: "pointer",
            }}
          >
            ⬇ Export PDF
          </button>
          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              fontSize: 22,
              cursor: "pointer",
              color: C.textMuted,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, display: "none" }} className="print-title">
            {title}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

type MetricTab =
  | "throughput"
  | "platform"
  | "handleTime"
  | "queueWait"
  | "worstMos"
  | "ivrTime";

const METRIC_TABS: { id: MetricTab; label: string }[] = [
  { id: "throughput", label: "Calls throughput" },
  { id: "platform", label: "Calls by source platform" },
  { id: "handleTime", label: "Agent handle time" },
  { id: "queueWait", label: "Queue wait time" },
  { id: "worstMos", label: "Worst call quality" },
  { id: "ivrTime", label: "IVR time" },
];

// Tabbed card: Calls throughput / Calls by source platform / Agent handle time /
// Queue wait time, all sharing one card footprint so the Insights row doesn't
// grow with every new metric, plus an Expand button per tab for a larger
// popover view — same TrendBarChart/PlatformPie components, just given more room.
function ThroughputCard({
  throughput,
  throughputByOutcome,
  platformBreakdown,
  handleTimeTrend,
  agentHandleTime,
  queueWaitTrend,
  queueWaitBreakdown,
  worstMosCalls,
  ivrTimeTrend,
  ivrTimeByIvr,
  onSelectAgent,
  onSelectQueue,
  onSelectIvr,
  onOpenCall,
}: {
  throughput: ThroughputPoint[];
  throughputByOutcome: ThroughputOutcomePoint[];
  platformBreakdown: PlatformBreakdownPoint[];
  handleTimeTrend: HandleTimeTrendPoint[];
  agentHandleTime: AgentHandleTime[];
  queueWaitTrend: QueueWaitTrendPoint[];
  queueWaitBreakdown: QueueWaitBreakdown[];
  worstMosCalls: WorstMosCall[];
  ivrTimeTrend: IvrTimeTrendPoint[];
  ivrTimeByIvr: IvrBreakdown[];
  onSelectAgent: (identity: string) => void;
  onSelectQueue: (queueId: string) => void;
  onSelectIvr: (ivrId: string) => void;
  onOpenCall: (callId: string) => void;
}) {
  const [tab, setTab] = useState<MetricTab>("throughput");
  const [expanded, setExpanded] = useState(false);
  const activeLabel = METRIC_TABS.find((t) => t.id === tab)!.label;

  function renderContent(big: boolean) {
    // Throughput and platform stand alone in their tab (no breakdown table below
    // them, unlike handle time / queue wait), so they get a taller chart/donut —
    // fills the space that would otherwise sit empty, and keeps all four tabs
    // roughly the same total height so switching tabs doesn't jump the page.
    const soloChartHeight = big ? 460 : 340;
    const pairedChartHeight = big ? 300 : 120;
    const pieSize = big ? 340 : 250; // fixed px — nested %-height flex chains proved unreliable

    if (tab === "throughput") {
      return <ThroughputOutcomeChart data={throughputByOutcome} height={soloChartHeight} />;
    }

    if (tab === "platform") {
      if (platformBreakdown.length === 0) {
        return (
          <div style={{ fontSize: 12.5, color: C.textMuted, padding: "10px 0" }}>
            No source platform data in this window.
          </div>
        );
      }
      return (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            minHeight: soloChartHeight,
          }}
        >
          <PlatformPie data={platformBreakdown} size={pieSize} />
        </div>
      );
    }

    if (tab === "handleTime") {
      return (
        <>
          <TrendBarChart
            title="Agent handle time"
            data={handleTimeTrend.map((d) => ({ bucketStart: d.bucketStart, value: d.avgSeconds }))}
            formatValue={fmtDur}
            height={pairedChartHeight}
          />
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
            <RankedTimeTable
              nameHeader="Agent"
              rows={agentHandleTime.map((a) => ({
                key: a.identity,
                label: a.displayName ?? a.identity,
                sublabel: a.displayName ? a.identity : undefined,
                count: a.callCount,
                avgSeconds: a.avgDurationSeconds,
              }))}
              onSelect={onSelectAgent}
            />
          </div>
        </>
      );
    }

    if (tab === "queueWait") {
      return (
        <>
          <TrendBarChart
            title="Queue wait time"
            data={queueWaitTrend.map((d) => ({ bucketStart: d.bucketStart, value: d.avgSeconds }))}
            formatValue={fmtDur}
            height={pairedChartHeight}
          />
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
            <RankedTimeTable
              nameHeader="Queue"
              rows={queueWaitBreakdown.map((q) => ({
                key: q.queueId,
                label: q.queueId,
                count: q.callCount,
                avgSeconds: q.avgWaitSeconds,
              }))}
              onSelect={onSelectQueue}
            />
          </div>
        </>
      );
    }

    if (tab === "worstMos") {
      if (worstMosCalls.length === 0) {
        return (
          <div style={{ fontSize: 12.5, color: C.textMuted, padding: "10px 0" }}>
            No voice quality (MOS) data in this window.
          </div>
        );
      }
      return <WorstMosTable calls={worstMosCalls} onSelect={onOpenCall} />;
    }

    return (
      <>
        <TrendBarChart
          title="IVR time"
          data={ivrTimeTrend.map((d) => ({ bucketStart: d.bucketStart, value: d.avgSeconds }))}
          formatValue={fmtDur}
          height={pairedChartHeight}
        />
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
          <RankedTimeTable
            nameHeader="IVR"
            rows={ivrTimeByIvr.map((i) => ({
              key: i.ivrId,
              label: i.ivrId,
              count: i.callCount,
              avgSeconds: i.avgTimeSeconds,
            }))}
            onSelect={onSelectIvr}
          />
        </div>
      </>
    );
  }

  return (
    <div
      style={{
        flex: "2 1 360px",
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 4,
        }}
      >
        <div style={{ display: "flex", gap: 2, background: C.surfaceAlt, borderRadius: 8, padding: 2 }}>
          {METRIC_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "5px 10px",
                borderRadius: 6,
                border: "none",
                background: tab === t.id ? C.surface : "transparent",
                color: tab === t.id ? C.ink : C.textMuted,
                fontSize: 11.5,
                fontWeight: 650,
                cursor: "pointer",
                boxShadow: tab === t.id ? "0 1px 2px rgba(15,22,32,0.08)" : "none",
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setExpanded(true)}
          title="Expand"
          aria-label="Expand"
          style={{
            border: `1px solid ${C.border}`,
            background: C.surface,
            color: C.textMid,
            borderRadius: 8,
            width: 30,
            height: 30,
            cursor: "pointer",
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          ⤢
        </button>
      </div>
      {renderContent(false)}
      {expanded && (
        <ExpandModal title={activeLabel} onClose={() => setExpanded(false)}>
          {renderContent(true)}
        </ExpandModal>
      )}
    </div>
  );
}

// ─── Export menu ──────────────────────────────────────────────────────────────
// Exports every record matching the current filters (all pages), not just the
// page currently visible in the table.
function ExportMenu({
  busy,
  onExport,
}: {
  busy: boolean;
  onExport: (format: "csv" | "json") => void;
}) {
  const [open, setOpen] = useState(false);

  const itemStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "9px 12px",
    border: "none",
    background: "transparent",
    color: C.ink,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          padding: "8px 14px",
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: C.surface,
          color: busy ? C.textMuted : C.ink,
          fontSize: 13,
          fontWeight: 650,
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy ? "Exporting…" : "⬇ Export"}
      </button>

      {open && !busy && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 29 }}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              zIndex: 30,
              minWidth: 160,
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              boxShadow: "0 14px 34px rgba(15,22,32,0.16)",
              padding: 4,
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => {
                onExport("csv");
                setOpen(false);
              }}
              style={itemStyle}
            >
              Export as CSV
            </button>
            <button
              onClick={() => {
                onExport("json");
                setOpen(false);
              }}
              style={itemStyle}
            >
              Export as JSON
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Records table ────────────────────────────────────────────────────────────
const TABLE_COLUMNS: { id: string; label: string; width: number; minWidth: number }[] = [
  { id: "callId", label: "Call ID", width: 170, minWidth: 100 },
  { id: "platform", label: "Platform", width: 110, minWidth: 80 },
  { id: "dir", label: "Dir", width: 56, minWidth: 40 },
  { id: "type", label: "Type", width: 100, minWidth: 70 },
  { id: "media", label: "Media", width: 100, minWidth: 70 },
  { id: "state", label: "State", width: 90, minWidth: 70 },
  { id: "start", label: "Start", width: 145, minWidth: 100 },
  { id: "duration", label: "Duration", width: 80, minWidth: 60 },
  { id: "ani", label: "ANI", width: 110, minWidth: 80 },
  { id: "dnis", label: "DNIS", width: 110, minWidth: 80 },
  { id: "rec", label: "Rec", width: 56, minWidth: 40 },
];

const NON_HIDEABLE_COLUMN_ID = "callId";

// v2: v1 persisted the full merged widths map on every mount, so once a
// browser loaded the table even once, its stored blob permanently overrode
// any later change to the code-level defaults (discovered when tightening
// the defaults did nothing for anyone who'd already visited). v2 stores only
// columns the user actually resized (see the persistence effect below) and
// uses a new key so pre-existing v1 blobs — which can't be told apart from a
// real customization — are simply abandoned rather than migrated.
const COLUMN_WIDTHS_KEY = "opencdr.recordsTable.columnWidths.v2";
const COLUMN_ORDER_KEY = "opencdr.recordsTable.columnOrder";
const COLUMN_HIDDEN_KEY = "opencdr.recordsTable.columnHidden";

function defaultColumnWidths(): Record<string, number> {
  const w: Record<string, number> = {};
  for (const c of TABLE_COLUMNS) w[c.id] = c.width;
  return w;
}

function loadColumnWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_KEY);
    const stored = raw ? JSON.parse(raw) : {};
    return { ...defaultColumnWidths(), ...stored };
  } catch {
    return defaultColumnWidths();
  }
}

function defaultColumnOrder(): string[] {
  return TABLE_COLUMNS.map((c) => c.id);
}

function loadColumnOrder(): string[] {
  const allIds = defaultColumnOrder();
  try {
    const raw = localStorage.getItem(COLUMN_ORDER_KEY);
    const stored: string[] = raw ? JSON.parse(raw) : [];
    const known = stored.filter((id) => allIds.includes(id));
    const missing = allIds.filter((id) => !known.includes(id));
    return [...known, ...missing]; // columns added since the stored order was saved land at the end
  } catch {
    return allIds;
  }
}

function loadColumnHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(COLUMN_HIDDEN_KEY);
    const stored: string[] = raw ? JSON.parse(raw) : [];
    return new Set(stored.filter((id) => id !== NON_HIDEABLE_COLUMN_ID));
  } catch {
    return new Set();
  }
}

function ColumnsMenu({
  columns,
  hiddenIds,
  onToggleHidden,
  onMove,
  onReset,
}: {
  columns: { id: string; label: string }[];
  hiddenIds: Set<string>;
  onToggleHidden: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);

  const iconBtn: React.CSSProperties = {
    border: "none",
    background: "transparent",
    color: C.textMuted,
    cursor: "pointer",
    fontSize: 12,
    padding: "2px 4px",
    lineHeight: 1,
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          border: "none",
          background: "transparent",
          color: C.textMuted,
          fontSize: 11,
          cursor: "pointer",
          padding: "2px 4px",
        }}
      >
        ⚙ Columns
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 29 }}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              zIndex: 30,
              minWidth: 220,
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              boxShadow: "0 14px 34px rgba(15,22,32,0.16)",
              padding: 4,
              overflow: "hidden",
            }}
          >
            {columns.map((c, i) => {
              const locked = c.id === NON_HIDEABLE_COLUMN_ID;
              const hidden = hiddenIds.has(c.id);
              return (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    fontSize: 12.5,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!hidden}
                    disabled={locked}
                    onChange={() => onToggleHidden(c.id)}
                    style={{ cursor: locked ? "default" : "pointer" }}
                  />
                  <span style={{ flex: 1, color: hidden ? C.textMuted : C.ink }}>
                    {c.label}
                    {locked && (
                      <span style={{ color: C.textMuted }}> (always shown)</span>
                    )}
                  </span>
                  <button
                    onClick={() => onMove(c.id, -1)}
                    disabled={i === 0}
                    title="Move up"
                    style={{ ...iconBtn, opacity: i === 0 ? 0.3 : 1 }}
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => onMove(c.id, 1)}
                    disabled={i === columns.length - 1}
                    title="Move down"
                    style={{ ...iconBtn, opacity: i === columns.length - 1 ? 0.3 : 1 }}
                  >
                    ↓
                  </button>
                </div>
              );
            })}
            <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 2, paddingTop: 2 }}>
              <button
                onClick={onReset}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "7px 10px",
                  border: "none",
                  background: "transparent",
                  color: C.textMuted,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                ↺ Reset to default
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RecordsTable({
  records,
  loading,
  onSelect,
  selectedId,
}: {
  records: CallRecord[];
  loading: boolean;
  onSelect: (r: CallRecord) => void;
  selectedId?: string;
}) {
  const [widths, setWidths] = useState<Record<string, number>>(loadColumnWidths);
  const [columnOrder, setColumnOrder] = useState<string[]>(loadColumnOrder);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(loadColumnHidden);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const dragRef = React.useRef<{ id: string; startX: number; startWidth: number } | null>(
    null
  );

  const toggleExpanded = (callId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  };

  useEffect(() => {
    try {
      // Only persist widths that differ from the current code defaults, not
      // the whole merged map — so a future default-width tweak takes effect
      // immediately for every column nobody has actually dragged, instead of
      // being permanently shadowed by a stale full-map blob (see COLUMN_WIDTHS_KEY).
      const defaults = defaultColumnWidths();
      const customized = Object.fromEntries(
        Object.entries(widths).filter(([id, w]) => w !== defaults[id])
      );
      localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(customized));
    } catch {
      // localStorage unavailable (private mode, etc.) — resizing still works, just not persisted.
    }
  }, [widths]);

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(columnOrder));
    } catch {
      // localStorage unavailable — reordering still works for the session, just not persisted.
    }
  }, [columnOrder]);

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_HIDDEN_KEY, JSON.stringify(Array.from(hiddenColumns)));
    } catch {
      // localStorage unavailable — hiding still works for the session, just not persisted.
    }
  }, [hiddenColumns]);

  const columnsById: Record<string, (typeof TABLE_COLUMNS)[number]> = {};
  for (const c of TABLE_COLUMNS) columnsById[c.id] = c;
  const orderedColumns = columnOrder.map((id) => columnsById[id]).filter(Boolean);
  const visibleColumns = orderedColumns.filter((c) => !hiddenColumns.has(c.id));

  const toggleColumnHidden = (id: string) => {
    if (id === NON_HIDEABLE_COLUMN_ID) return;
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const moveColumn = (id: string, direction: -1 | 1) => {
    setColumnOrder((prev) => {
      const idx = prev.indexOf(id);
      const swapWith = idx + direction;
      if (idx < 0 || swapWith < 0 || swapWith >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      return next;
    });
  };

  const resetColumnsConfig = () => {
    setColumnOrder(defaultColumnOrder());
    setHiddenColumns(new Set());
  };

  const onResizeMove = (e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const col = TABLE_COLUMNS.find((c) => c.id === d.id);
    const min = col?.minWidth ?? 40;
    const next = Math.max(min, d.startWidth + (e.clientX - d.startX));
    setWidths((w) => ({ ...w, [d.id]: next }));
  };

  const onResizeEnd = () => {
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeEnd);
  };

  const onResizeStart = (colId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { id: colId, startX: e.clientX, startWidth: widths[colId] };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", onResizeEnd);
  };

  const resetWidths = () => setWidths(defaultColumnWidths());

  const head: React.CSSProperties = {
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.textMuted,
    fontWeight: 700,
    textAlign: "left",
    padding: "10px 12px",
    borderBottom: `1px solid ${C.border}`,
    position: "sticky",
    top: 0,
    background: C.surfaceAlt,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  };
  const cell: React.CSSProperties = {
    padding: "11px 12px",
    fontSize: 13,
    borderBottom: `1px solid ${C.border}`,
    verticalAlign: "middle",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  };

  return (
    <div
      style={{
        marginTop: 16,
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4,
          padding: "6px 10px 0",
        }}
      >
        <ColumnsMenu
          columns={orderedColumns}
          hiddenIds={hiddenColumns}
          onToggleHidden={toggleColumnHidden}
          onMove={moveColumn}
          onReset={resetColumnsConfig}
        />
        <button
          onClick={resetWidths}
          style={{
            border: "none",
            background: "transparent",
            color: C.textMuted,
            fontSize: 11,
            cursor: "pointer",
            padding: "2px 4px",
          }}
        >
          ↺ Reset widths
        </button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", tableLayout: "fixed", width: "max-content" }}>
          <colgroup>
            {visibleColumns.map((c) => (
              <col key={c.id} style={{ width: widths[c.id] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {visibleColumns.map((c) => (
                <th key={c.id} style={{ ...head, position: "relative" }}>
                  {c.label}
                  <span
                    onMouseDown={onResizeStart(c.id)}
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={(e) => {
                      const grip = e.currentTarget.firstElementChild as HTMLElement;
                      grip.style.background = C.accent;
                      grip.style.opacity = "1";
                    }}
                    onMouseLeave={(e) => {
                      const grip = e.currentTarget.firstElementChild as HTMLElement;
                      grip.style.background = C.borderStrong;
                      grip.style.opacity = "0.7";
                    }}
                    style={{
                      position: "absolute",
                      right: -3,
                      top: 0,
                      height: "100%",
                      width: 7,
                      cursor: "col-resize",
                      zIndex: 1,
                      display: "flex",
                      justifyContent: "center",
                    }}
                  >
                    <span
                      style={{
                        width: 2,
                        height: "55%",
                        alignSelf: "center",
                        borderRadius: 999,
                        background: C.borderStrong,
                        opacity: 0.7,
                      }}
                    />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && records.length === 0 && (
              <tr>
                <td
                  style={{ ...cell, textAlign: "center", color: C.textMuted }}
                  colSpan={visibleColumns.length}
                >
                  Loading…
                </td>
              </tr>
            )}
            {!loading && records.length === 0 && (
              <tr>
                <td
                  style={{ ...cell, textAlign: "center", color: C.textMuted, padding: 28 }}
                  colSpan={visibleColumns.length}
                >
                  No records in this window. Widen the time range, clear filters, or
                  ingest some records.
                </td>
              </tr>
            )}
            {records.map((r) => {
              const st = stateStyle(r.callState);
              const rec = r.cloudRecording?.recordingStatus;
              const isSel = r.callId === selectedId;
              const { ani, dnis, extraParticipants } = computeAniDnis(r);
              const isExpandable = extraParticipants.length > 0;
              const isExpanded = expandedIds.has(r.callId);

              const cellsById: Record<string, { style?: React.CSSProperties; content: React.ReactNode }> = {
                callId: {
                  style: { fontFamily: MONO, color: C.accentDeep },
                  content: (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      {isExpandable ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpanded(r.callId);
                          }}
                          title={
                            isExpanded
                              ? "Collapse participants"
                              : `Show ${extraParticipants.length} more participant${
                                  extraParticipants.length === 1 ? "" : "s"
                                }`
                          }
                          style={{
                            border: "none",
                            background: "transparent",
                            color: C.textMuted,
                            cursor: "pointer",
                            fontSize: 15,
                            lineHeight: 1,
                            padding: 0,
                            width: 16,
                            flexShrink: 0,
                          }}
                        >
                          {isExpanded ? "▾" : "▸"}
                        </button>
                      ) : (
                        <span style={{ width: 16, display: "inline-block", flexShrink: 0 }} />
                      )}
                      <span title={r.callId}>{r.callId}</span>
                    </span>
                  ),
                },
                platform: {
                  style: { fontFamily: MONO, fontSize: 12, color: C.textMid },
                  content: r.sourcePlatformId ? (
                    <span title={r.sourcePlatformType ?? undefined}>{r.sourcePlatformId}</span>
                  ) : (
                    <span style={{ color: C.textMuted }}>—</span>
                  ),
                },
                dir: {
                  style: { textAlign: "center" },
                  content: (
                    <span title={r.callDirection}>
                      {directionGlyph[r.callDirection ?? "unknown"] ?? "·"}
                    </span>
                  ),
                },
                type: {
                  style: { color: C.textMid, fontFamily: MONO, fontSize: 12 },
                  content: (r.callType ?? "—").replace(/_/g, " "),
                },
                media: {
                  content: (
                    <span title={r.mediaType}>
                      {mediaGlyph[r.mediaType] ?? "·"}{" "}
                      <span style={{ color: C.textMid, fontSize: 12 }}>
                        {r.mediaType.replace(/_/g, " ")}
                      </span>
                    </span>
                  ),
                },
                state: {
                  content: (
                    <Pill fg={st.fg} bg={st.bg}>
                      {st.label}
                    </Pill>
                  ),
                },
                start: {
                  style: { fontFamily: MONO, fontSize: 12, color: C.textMid },
                  content: fmt(r.callStartTime),
                },
                duration: {
                  style: { fontFamily: MONO },
                  content: fmtDur(r.durationSeconds),
                },
                ani: {
                  style: { fontFamily: MONO, fontSize: 12, color: C.textMid },
                  content: ani,
                },
                dnis: {
                  style: { fontFamily: MONO, fontSize: 12, color: C.textMid },
                  content: dnis,
                },
                rec: {
                  content:
                    rec === "recorded" ? (
                      <span title="recorded" style={{ color: C.amber, fontSize: 15 }}>
                        ●
                      </span>
                    ) : rec === "partial" ? (
                      <span title="partial" style={{ color: C.amber, fontSize: 15 }}>
                        ◐
                      </span>
                    ) : (
                      <span title={rec ?? "unknown"} style={{ color: C.textMuted }}>
                        ○
                      </span>
                    ),
                },
              };

              return (
                <React.Fragment key={r.callId}>
                  <tr
                    onClick={() => onSelect(r)}
                    style={{
                      cursor: "pointer",
                      background: isSel ? C.accentSoft : "transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (!isSel) e.currentTarget.style.background = C.surfaceAlt;
                    }}
                    onMouseLeave={(e) => {
                      if (!isSel) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    {visibleColumns.map((c) => (
                      <td key={c.id} style={{ ...cell, ...cellsById[c.id]?.style }}>
                        {cellsById[c.id]?.content}
                      </td>
                    ))}
                  </tr>
                  {isExpanded &&
                    extraParticipants.map((p) => (
                      <tr
                        key={`${r.callId}-${p.participantId}`}
                        style={{ background: C.surfaceAlt }}
                      >
                        <td
                          colSpan={visibleColumns.length}
                          style={{ ...cell, paddingLeft: 34, color: C.textMid, fontSize: 12.5 }}
                        >
                          <span style={{ color: C.textMuted, marginRight: 8 }}>↳</span>
                          <Pill fg={C.textMid} bg={C.surfaceDeep}>
                            {p.role.replace(/_/g, " ")}
                          </Pill>
                          <span style={{ marginLeft: 8, fontFamily: MONO }}>{p.extension}</span>
                          {p.displayName && (
                            <span style={{ marginLeft: 8, color: C.textMuted }}>
                              {p.displayName}
                            </span>
                          )}
                          {(p.joinTime || p.leaveTime) && (
                            <span
                              style={{
                                marginLeft: 8,
                                color: C.textMuted,
                                fontFamily: MONO,
                                fontSize: 12,
                              }}
                            >
                              {p.joinTime ? fmt(p.joinTime) : ""}
                              {p.leaveTime ? ` – ${fmt(p.leaveTime)}` : ""}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250];

function Pager({
  pagination,
  pageSize,
  onPageSizeChange,
  onPrev,
  onNext,
}: {
  pagination: Pagination;
  pageSize: number;
  onPageSizeChange: (n: number) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const btn = (disabled: boolean): React.CSSProperties => ({
    padding: "7px 14px",
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.surface,
    fontSize: 13,
    fontWeight: 600,
    color: disabled ? C.textMuted : C.ink,
    cursor: disabled ? "default" : "pointer",
  });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 14,
        fontSize: 13,
        color: C.textMid,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span>
          Page {pagination.page} of {pagination.totalPages} ·{" "}
          {pagination.totalRecords} records
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: C.textMuted, fontSize: 12.5 }}>Rows per page</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            style={{
              padding: "5px 8px",
              borderRadius: 6,
              border: `1px solid ${C.border}`,
              background: C.surface,
              fontSize: 12.5,
              color: C.ink,
              fontFamily: SANS,
              outline: "none",
              cursor: "pointer",
            }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={btn(pagination.page <= 1)} disabled={pagination.page <= 1} onClick={onPrev}>
          ← Prev
        </button>
        <button
          style={btn(pagination.page >= pagination.totalPages)}
          disabled={pagination.page >= pagination.totalPages}
          onClick={onNext}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ─── Detail drawer ────────────────────────────────────────────────────────────
// A clickable call ID inside the detail drawer's "Related legs" section —
// drills across to that leg's own record via onDrill.
function CallLegLink({
  callId,
  onClick,
  disabled,
}: {
  callId: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={`Open ${callId}`}
      style={{
        border: "none",
        background: "transparent",
        padding: 0,
        margin: 0,
        color: C.accentDeep,
        fontFamily: MONO,
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        textDecoration: "underline",
        textDecorationColor: disabled ? "transparent" : `${C.accentDeep}55`,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {callId}
    </button>
  );
}

function DetailDrawer({
  record,
  onClose,
  onBack,
  onDrill,
  drillLoading,
  drillError,
}: {
  record: CallRecord;
  onClose: () => void;
  onBack?: () => void;
  onDrill: (callId: string) => void;
  drillLoading: boolean;
  drillError: string | null;
}) {
  const st = stateStyle(record.callState);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showVendorFields, setShowVendorFields] = useState(false);
  const handleExport = (format: "csv" | "json") => {
    if (format === "csv") {
      downloadBlob(`cdr-${record.callId}.csv`, toCsv([record]), "text/csv;charset=utf-8");
    } else {
      downloadBlob(`cdr-${record.callId}.json`, JSON.stringify(record, null, 2), "application/json");
    }
  };
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,22,32,0.34)",
        zIndex: 40,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 100%)",
          height: "100%",
          background: C.bg,
          overflowY: "auto",
          boxShadow: "-14px 0 40px rgba(15,22,32,0.18)",
        }}
      >
        {/* Drawer header */}
        <div
          style={{
            padding: "18px 22px",
            background: C.surface,
            borderBottom: `1px solid ${C.border}`,
            position: "sticky",
            top: 0,
            zIndex: 2,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onBack && (
              <button
                onClick={onBack}
                title="Back to the previous call"
                style={{
                  border: `1px solid ${C.border}`,
                  background: C.surfaceAlt,
                  color: C.textMid,
                  borderRadius: 7,
                  padding: "4px 9px",
                  fontSize: 12.5,
                  fontWeight: 650,
                  cursor: "pointer",
                }}
              >
                ← Back
              </button>
            )}
            <Pill fg={st.fg} bg={st.bg}>
              {st.label}
            </Pill>
            <span style={{ fontSize: 13, color: C.textMid }}>
              {directionGlyph[record.callDirection ?? "unknown"]}{" "}
              {(record.callDirection ?? "unknown")} ·{" "}
              {(record.callType ?? "call").replace(/_/g, " ")} ·{" "}
              {record.mediaType.replace(/_/g, " ")}
            </span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
              <ExportMenu busy={false} onExport={handleExport} />
              <button
                onClick={onClose}
                style={{
                  border: "none",
                  background: "transparent",
                  fontSize: 22,
                  cursor: "pointer",
                  color: C.textMuted,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 13, color: C.accentDeep, marginTop: 8 }}>
            {record.callId}
          </div>
          {record._scenario && (
            <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 4 }}>
              {record._scenario}
            </div>
          )}
        </div>

        <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
          {(record.sourcePlatformType || record.sourcePlatformId) && (
            <Section title="Source platform">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <Field label="Platform type">{record.sourcePlatformType}</Field>
                <Field label="Platform ID">{record.sourcePlatformId}</Field>
              </div>
            </Section>
          )}

          <Section title="Timing">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Field label="Start">{fmt(record.callStartTime)}</Field>
              <Field label="End">{fmt(record.callEndTime)}</Field>
              <Field label="Duration">{fmtDur(record.durationSeconds)}</Field>
              <Field label="Last update">{fmt(record.lastUpdateTime)}</Field>
              {record.interactionStartTime && record.interactionStartTime !== record.callStartTime && (
                <Field label="Interaction start">{fmt(record.interactionStartTime)}</Field>
              )}
              {record.interactionEndTime && record.interactionEndTime !== record.callEndTime && (
                <Field label="Interaction end">{fmt(record.interactionEndTime)}</Field>
              )}
            </div>
          </Section>

          {record.callSource && (
            <Section title="Routing">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {record.callSource.huntNumber && (
                  <Field label="Hunt number">{record.callSource.huntNumber}</Field>
                )}
                {record.callSource.ivrInfo && (
                  <Field label="IVR">{record.callSource.ivrInfo}</Field>
                )}
                {record.callSource.queueInfo && (
                  <Field label="Queue / ACD">{record.callSource.queueInfo}</Field>
                )}
                {record.callSource.timeInIvrSeconds != null && (
                  <Field label="Time in IVR">
                    {fmtDur(record.callSource.timeInIvrSeconds)}
                  </Field>
                )}
                {record.callSource.timeInQueueSeconds != null && (
                  <Field label="Time in queue">
                    {fmtDur(record.callSource.timeInQueueSeconds)}
                  </Field>
                )}
              </div>
            </Section>
          )}

          <Section title={`Participants · ${record.participants.length}`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {record.participants.map((p) => (
                <ParticipantCard key={p.participantId} p={p} />
              ))}
            </div>
          </Section>

          {record.events && record.events.length > 0 && (
            <Section
              title={`Call trace · ${record.events.length} events`}
              action={
                <button
                  onClick={() => setShowTimeline(true)}
                  title="Open interaction timeline"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    border: `1px solid ${C.border}`,
                    background: C.surface,
                    color: C.textMid,
                    borderRadius: 7,
                    padding: "4px 9px",
                    fontSize: 11.5,
                    fontWeight: 650,
                    cursor: "pointer",
                  }}
                >
                  ⤢ Timeline
                </button>
              }
            >
              <EventTrace events={record.events} />
            </Section>
          )}

          {record.cloudRecording && (
            <Section title="Recording">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <Field label="Status">{record.cloudRecording.recordingStatus}</Field>
                <Field label="Method">{record.cloudRecording.recordingMethod}</Field>
                <Field label="Recording ID">{record.cloudRecording.recordingId}</Field>
                <Field label="Media file">{record.cloudRecording.mediaName}</Field>
              </div>
              {record.cloudRecording.downloadPath && (
                <a
                  href={record.cloudRecording.downloadPath}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-block",
                    marginTop: 10,
                    fontSize: 13,
                    color: C.accentDeep,
                    fontWeight: 600,
                  }}
                >
                  Open recording ↗
                </a>
              )}
            </Section>
          )}

          {record.transcription && (
            <Section title="Transcription">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <Field label="Status">{record.transcription.transcriptionStatus}</Field>
                <Field label="Method">{record.transcription.transcriptionMethod}</Field>
                <Field label="Provider">{record.transcription.provider}</Field>
                <Field label="Language">{record.transcription.language}</Field>
                <Field label="Confidence">
                  {record.transcription.confidenceScore != null
                    ? `${Math.round(record.transcription.confidenceScore * 100)}%`
                    : "—"}
                </Field>
                <Field label="Word count">{record.transcription.wordCount}</Field>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                {record.transcription.redacted && (
                  <Pill fg={C.amber} bg={C.amberSoft}>
                    PII redacted
                  </Pill>
                )}
                {record.transcription.downloadPath && (
                  <a
                    href={record.transcription.downloadPath}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 13, color: C.accentDeep, fontWeight: 600 }}
                  >
                    Open transcript ↗
                  </a>
                )}
              </div>
            </Section>
          )}

          {record.qos && (
            <Section title="Quality of service">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
                <Field label="MOS">{record.qos.mosScore}</Field>
                <Field label="Latency">
                  {record.qos.latencyMs != null ? `${record.qos.latencyMs} ms` : "—"}
                </Field>
                <Field label="Jitter">
                  {record.qos.jitterMs != null ? `${record.qos.jitterMs} ms` : "—"}
                </Field>
                <Field label="Packet loss">
                  {record.qos.packetLossPercent != null
                    ? `${record.qos.packetLossPercent}%`
                    : "—"}
                </Field>
                <Field label="Packets">{record.qos.packetsTotal}</Field>
              </div>
            </Section>
          )}

          {(record.parentCallId ||
            (record.relatedCallIds && record.relatedCallIds.length > 0)) && (
            <Section title="Related legs">
              {record.parentCallId && (
                <Field label="Parent call">
                  <CallLegLink
                    callId={record.parentCallId}
                    onClick={() => onDrill(record.parentCallId!)}
                    disabled={drillLoading}
                  />
                </Field>
              )}
              {record.relatedCallIds && record.relatedCallIds.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <Field label="Related calls">
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
                      {record.relatedCallIds.map((id) => (
                        <CallLegLink
                          key={id}
                          callId={id}
                          onClick={() => onDrill(id)}
                          disabled={drillLoading}
                        />
                      ))}
                    </div>
                  </Field>
                </div>
              )}
              {drillLoading && (
                <div style={{ marginTop: 8, fontSize: 12, color: C.textMuted }}>Loading…</div>
              )}
              {drillError && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "8px 10px",
                    borderRadius: 6,
                    background: C.roseSoft,
                    color: C.rose,
                    fontSize: 12.5,
                  }}
                >
                  {drillError}
                </div>
              )}
            </Section>
          )}

          {record.wrapUpInfo && (
            <Section title="Wrap-up">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <Field label="Code">{record.wrapUpInfo.wrapUpCode}</Field>
                <Field label="Duration">
                  {fmtDur(record.wrapUpInfo.wrapUpDurationSeconds)}
                </Field>
                {record.wrapUpInfo.wrapUpNotes && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <Field label="Notes">{record.wrapUpInfo.wrapUpNotes}</Field>
                  </div>
                )}
              </div>
            </Section>
          )}

          {record.vendorSpecificFields && Object.keys(record.vendorSpecificFields).length > 0 && (
            <Section title="Platform extensions">
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.textMid }}>
                <span>
                  {Object.keys(record.vendorSpecificFields).length} field
                  {Object.keys(record.vendorSpecificFields).length === 1 ? "" : "s"} outside the standard
                </span>
                <span style={{ position: "relative" }}>
                  <InfoButton
                    active={showVendorFields}
                    onClick={() => setShowVendorFields((v) => !v)}
                    title="Show vendor-specific fields"
                  />
                  {showVendorFields && (
                    <KeyValuePopover
                      entries={Object.entries(record.vendorSpecificFields)}
                      onClose={() => setShowVendorFields(false)}
                    />
                  )}
                </span>
              </div>
            </Section>
          )}
        </div>
      </div>
      {showTimeline && (
        <InteractionTimelineModal record={record} onClose={() => setShowTimeline(false)} />
      )}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 12,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: C.textMid,
            fontWeight: 750,
          }}
        >
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ParticipantCard({ p }: { p: Participant }) {
  const [showDevice, setShowDevice] = useState(false);
  // The less-common device fields — deviceId, model, softwareVersion, macAddress,
  // videoCodec — go in the popup rather than as more inline chips; audioCodec/
  // ipAddress stay inline below since they're already shown there.
  const deviceEntries: [string, unknown][] = [];
  if (p.deviceId) deviceEntries.push(["Device ID", p.deviceId]);
  if (p.device?.model) deviceEntries.push(["Model", p.device.model]);
  if (p.device?.softwareVersion) deviceEntries.push(["Software version", p.device.softwareVersion]);
  if (p.device?.macAddress) deviceEntries.push(["MAC address", p.device.macAddress]);
  if (p.device?.videoCodec) deviceEntries.push(["Video codec", p.device.videoCodec]);

  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: "10px 12px",
        background: C.surfaceAlt,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Pill fg={C.accentDeep} bg={C.accentSoft}>
          {p.role.replace(/_/g, " ")}
        </Pill>
        <span
          title="participantId — matches p1/p2/... references in the Call trace below"
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: C.textMuted,
            background: C.surfaceDeep,
            padding: "2px 6px",
            borderRadius: 5,
          }}
        >
          {p.participantId}
        </span>
        <span style={{ fontWeight: 650, fontSize: 14 }}>
          {p.displayName ?? p.userId ?? p.extension}
          {p.displayName && p.userId && (
            <span style={{ fontWeight: 500, fontFamily: MONO, fontSize: 12.5, color: C.textMid }}>
              {" "}
              ({p.userId})
            </span>
          )}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.textMid }}>
          ext {p.extension}
        </span>
        {deviceEntries.length > 0 && (
          <span style={{ position: "relative" }}>
            <InfoButton active={showDevice} onClick={() => setShowDevice((v) => !v)} title="Show device info" />
            {showDevice && (
              <KeyValuePopover entries={deviceEntries} onClose={() => setShowDevice(false)} />
            )}
          </span>
        )}
        {p.recordingConfig && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 11.5,
              color: p.recordingConfig === "record" ? C.amber : C.textMuted,
              fontWeight: 600,
            }}
          >
            {p.recordingConfig === "record" ? "● recording" : p.recordingConfig.replace(/_/g, " ")}
          </span>
        )}
      </div>
      <div
        style={{
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
          marginTop: 8,
          fontSize: 12,
          color: C.textMid,
          fontFamily: MONO,
        }}
      >
        {p.group && <span>group: {p.group}</span>}
        {p.slotNumber && <span>slot: {p.slotNumber}</span>}
        {p.handsetInfo && <span>handset: {p.handsetInfo}</span>}
        {p.device?.audioCodec && <span>codec: {p.device.audioCodec}</span>}
        {p.device?.ipAddress && <span>ip: {p.device.ipAddress}</span>}
        {p.joinTime && <span>joined: {fmtTimeOnly(p.joinTime)}</span>}
        {p.leaveTime && <span>left: {fmtTimeOnly(p.leaveTime)}</span>}
      </div>
    </div>
  );
}

// ─── Signature: the call-event trace timeline ─────────────────────────────────
// ─── Interaction timeline (swimlane) ────────────────────────────────────────
// One row per participant, colored segments show their state over a shared
// wall-clock axis. Segment color is a small reserved status vocabulary (not
// per-row categorical — the row already conveys identity), reusing this app's
// existing hues where the meaning already matches (eventStyle() above already
// colors connected→teal, hold→violet).
type SegmentKind = "waiting" | "active" | "hold" | "wrapup";

interface TimelineSegment {
  kind: SegmentKind;
  startMs: number;
  endMs: number;
}

interface TimelineRow {
  participant: Participant;
  segments: TimelineSegment[];
}

const SEGMENT_STYLE: Record<SegmentKind, { color: string; label: string }> = {
  waiting: { color: C.amber, label: "Waiting" },
  active: { color: C.teal, label: "Active" },
  hold: { color: C.violet, label: "Hold" },
  wrapup: { color: C.accent, label: "Wrap-up" },
};

function findEvent(
  pEvents: CallEvent[],
  allEvents: CallEvent[],
  type: string
): CallEvent | undefined {
  return pEvents.find((e) => e.eventType === type) ?? allEvents.find((e) => e.eventType === type);
}

// Carves [start, end] into active/hold segments using any hold/resume events
// scoped to this participant inside that window; one active segment if none.
function splitHold(pEvents: CallEvent[], start: number, end: number): TimelineSegment[] {
  const toggles = pEvents
    .filter((e) => e.eventType === "hold" || e.eventType === "resume")
    .map((e) => ({ type: e.eventType, t: new Date(e.eventTime).getTime() }))
    .filter((e) => e.t > start && e.t < end)
    .sort((a, b) => a.t - b.t);

  if (toggles.length === 0) return [{ kind: "active", startMs: start, endMs: end }];

  const segments: TimelineSegment[] = [];
  let cursor = start;
  let kind: SegmentKind = "active";
  for (const t of toggles) {
    segments.push({ kind, startMs: cursor, endMs: t.t });
    cursor = t.t;
    kind = t.type === "hold" ? "hold" : "active";
  }
  segments.push({ kind, startMs: cursor, endMs: end });
  return segments;
}

/**
 * Derives per-participant timeline segments from whatever level of detail a
 * record actually has — explicit joinTime/leaveTime (conference calls),
 * participant-scoped events (ringing/connected/hold/disconnected), IVR/queue
 * entry-exit events (falling back to callSource's duration fields), or — for
 * the sparsest records — one honest "active" span covering the whole call.
 */
function deriveTimelineRows(record: CallRecord): TimelineRow[] {
  const events = record.events ?? [];
  const callStart = new Date(record.callStartTime).getTime();
  const callEnd = record.callEndTime
    ? new Date(record.callEndTime).getTime()
    : record.lastUpdateTime
    ? new Date(record.lastUpdateTime).getTime()
    : callStart;

  const rows: TimelineRow[] = record.participants.map((p) => {
    const pEvents = events.filter((e) => e.participantId === p.participantId);
    const segments: TimelineSegment[] = [];

    if (p.role === "ivr" || p.role === "queue") {
      const entryType = p.role === "ivr" ? "ivr_entry" : "queue_entry";
      const exitType = p.role === "ivr" ? "ivr_exit" : "queue_exit";
      const entry = findEvent(pEvents, events, entryType);
      const exit = findEvent(pEvents, events, exitType);
      if (entry) {
        const s = new Date(entry.eventTime).getTime();
        const e = exit ? new Date(exit.eventTime).getTime() : s;
        segments.push({ kind: "waiting", startMs: s, endMs: Math.max(e, s) });
      } else {
        const dur =
          p.role === "ivr" ? record.callSource?.timeInIvrSeconds : record.callSource?.timeInQueueSeconds;
        if (dur != null) {
          segments.push({ kind: "waiting", startMs: callStart, endMs: callStart + dur * 1000 });
        }
      }
    } else if (p.joinTime) {
      const s = new Date(p.joinTime).getTime();
      const e = p.leaveTime ? new Date(p.leaveTime).getTime() : callEnd;
      segments.push(...splitHold(pEvents, s, e));
    } else {
      const ringing = findEvent(pEvents, [], "ringing"); // ringing is always participant-targeted when present
      const connected = findEvent(pEvents, events, "connected");
      const disconnect = findEvent(pEvents, events, "disconnected");

      if (ringing || connected) {
        const ringS = ringing ? new Date(ringing.eventTime).getTime() : null;
        const connS = connected ? new Date(connected.eventTime).getTime() : ringS ?? callStart;
        const endS = disconnect ? new Date(disconnect.eventTime).getTime() : callEnd;
        if (ringS != null && ringS < connS) {
          segments.push({ kind: "waiting", startMs: ringS, endMs: connS });
        } else if (ringS == null && p.role === "caller" && connS > callStart) {
          // The caller dialed in at call start and was live through any IVR/queue
          // routing before reaching the agent — show that as presence, not a gap.
          segments.push({ kind: "waiting", startMs: callStart, endMs: connS });
        }
        segments.push(...splitHold(pEvents, connS, Math.max(connS, endS)));
      } else {
        segments.push({ kind: "active", startMs: callStart, endMs: Math.max(callStart, callEnd) });
      }
    }

    return { participant: p, segments };
  });

  // Wrap-up tail belongs to whoever handled the interaction (agent, transfer
  // source/target, barge-in supervisor, ...), never the dialing customer —
  // prefer the first non-caller row, falling back to the old first-row pick
  // only if every row is somehow "caller" (so the tail still renders somewhere
  // rather than being silently dropped).
  if (record.wrapUpInfo?.wrapUpDurationSeconds != null) {
    const isEligible = (r: TimelineRow) =>
      r.participant.role !== "ivr" && r.participant.role !== "queue" && r.segments.length > 0;
    const target =
      rows.find((r) => isEligible(r) && r.participant.role !== "caller") ?? rows.find(isEligible);
    if (target) {
      const lastEnd = Math.max(...target.segments.map((s) => s.endMs));
      target.segments.push({
        kind: "wrapup",
        startMs: lastEnd,
        endMs: lastEnd + record.wrapUpInfo.wrapUpDurationSeconds * 1000,
      });
    }
  }

  return rows.filter((r) => r.segments.length > 0);
}

// Small key/value popover for an event's raw `metadata` — DTMF digit + IVR
// menu on function_key_press, queuePosition on queue_entry/exit, transfer
// reason, selected IVR option, etc. Shape is event-type-specific and not
// worth hand-rolling fields for, so this just lists whatever keys are there.
// Generic key/value popover — used for an event's raw `metadata` and for a
// participant's less-common device fields. Shape is caller-specific and not
// worth hand-rolling fields for, so this just lists whatever entries it's given.
function KeyValuePopover({ entries, onClose }: { entries: [string, unknown][]; onClose: () => void }) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9 }} />
      <div
        style={{
          position: "absolute",
          top: "calc(100% + 4px)",
          left: 0,
          zIndex: 10,
          minWidth: 180,
          maxWidth: 320,
          background: C.ink,
          color: "#fff",
          borderRadius: 8,
          padding: "8px 10px",
          boxShadow: "0 14px 34px rgba(15,22,32,0.28)",
          fontSize: 11.5,
        }}
      >
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
            <span style={{ opacity: 0.7, fontFamily: MONO }}>{k}</span>
            <span style={{ marginLeft: "auto", fontFamily: MONO, textAlign: "right" }}>
              {typeof v === "string" ? v : JSON.stringify(v)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

// Small round "i" toggle that anchors a KeyValuePopover — shared by the Call
// trace's event-metadata button and ParticipantCard's device-info button.
function InfoButton({ active, onClick, title }: { active: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        border: `1px solid ${C.border}`,
        background: active ? C.surfaceAlt : "transparent",
        color: C.textMuted,
        borderRadius: 999,
        width: 16,
        height: 16,
        lineHeight: 1,
        fontSize: 10.5,
        fontWeight: 700,
        cursor: "pointer",
        padding: 0,
      }}
    >
      i
    </button>
  );
}

function EventTrace({ events }: { events: CallEvent[] }) {
  const [openMeta, setOpenMeta] = useState<number | null>(null);
  const sorted = [...events].sort(
    (a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime()
  );
  const t0 = new Date(sorted[0].eventTime).getTime();

  return (
    <div style={{ position: "relative", paddingLeft: 4 }}>
      {sorted.map((ev, i) => {
        const es = eventStyle(ev.eventType);
        const offsetMs = new Date(ev.eventTime).getTime() - t0;
        const rel =
          offsetMs === 0
            ? "+0s"
            : offsetMs < 1000
            ? `+${offsetMs}ms`
            : `+${Math.round(offsetMs / 1000)}s`;
        const last = i === sorted.length - 1;
        return (
          <div key={i} style={{ display: "flex", gap: 12, position: "relative" }}>
            {/* rail + node */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 16 }}>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  background: es.color,
                  boxShadow: `0 0 0 3px ${es.soft}`,
                  zIndex: 1,
                  marginTop: 3,
                }}
              />
              {!last && (
                <span
                  style={{
                    width: 2,
                    flex: 1,
                    minHeight: 26,
                    background: C.border,
                    marginTop: 2,
                  }}
                />
              )}
            </div>
            {/* content */}
            <div style={{ paddingBottom: last ? 0 : 16, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontWeight: 650, fontSize: 13.5, color: es.color, textTransform: "capitalize" }}>
                  {es.label}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.textMuted }}>
                  {fmtTimeOnly(ev.eventTime)} · {rel}
                </span>
                {ev.metadata && Object.keys(ev.metadata).length > 0 && (
                  <span style={{ position: "relative" }}>
                    <InfoButton
                      active={openMeta === i}
                      onClick={() => setOpenMeta(openMeta === i ? null : i)}
                      title="Show event metadata"
                    />
                    {openMeta === i && (
                      <KeyValuePopover entries={Object.entries(ev.metadata)} onClose={() => setOpenMeta(null)} />
                    )}
                  </span>
                )}
              </div>
              {(ev.detail || ev.participantId || ev.targetParticipantId) && (
                <div style={{ fontSize: 12.5, color: C.textMid, marginTop: 2 }}>
                  {ev.detail}
                  {ev.participantId && (
                    <span style={{ fontFamily: MONO, color: C.textMuted }}>
                      {ev.detail ? "  ·  " : ""}
                      {ev.participantId}
                      {ev.targetParticipantId ? ` → ${ev.targetParticipantId}` : ""}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Same dark-tooltip pattern already used in TrendBarChart, applied to a
// segment instead of a bar.
function TimelineTooltip({ label, kind, startMs, endMs }: { label: string; kind: SegmentKind; startMs: number; endMs: number }) {
  const st = SEGMENT_STYLE[kind];
  return (
    <div
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        left: "50%",
        transform: "translateX(-50%)",
        background: C.ink,
        color: "#fff",
        fontSize: 11.5,
        padding: "6px 10px",
        borderRadius: 6,
        whiteSpace: "nowrap",
        zIndex: 6,
        pointerEvents: "none",
      }}
    >
      <div>
        <strong>{st.label}</strong> <span style={{ opacity: 0.85 }}>· {label}</span>
      </div>
      <div style={{ fontFamily: MONO, opacity: 0.85, marginTop: 2 }}>
        {fmtTimeOnly(new Date(startMs).toISOString())} – {fmtTimeOnly(new Date(endMs).toISOString())} (
        {fmtDur((endMs - startMs) / 1000)})
      </div>
    </div>
  );
}

function InteractionTimelineModal({ record, onClose }: { record: CallRecord; onClose: () => void }) {
  const [hover, setHover] = useState<{ row: number; seg: number } | null>(null);
  const rows = deriveTimelineRows(record);

  if (rows.length === 0) {
    return (
      <div
        // Nested inside DetailDrawer's own click-to-close overlay — stop
        // propagation here too, or clicking this backdrop would cascade into
        // closing the drawer underneath it as well.
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15,22,32,0.38)",
          zIndex: 50,
          display: "grid",
          placeItems: "center",
          padding: 20,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ background: C.surface, borderRadius: 14, padding: 24, maxWidth: 360 }}
        >
          <div style={{ fontSize: 13, color: C.textMid }}>
            Not enough timing detail on this record to draw a timeline.
          </div>
          <button
            onClick={onClose}
            style={{
              marginTop: 14,
              padding: "8px 14px",
              borderRadius: 8,
              border: "none",
              background: C.ink,
              color: "#fff",
              fontSize: 13,
              fontWeight: 650,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  const allMs = rows.flatMap((r) => r.segments.flatMap((s) => [s.startMs, s.endMs]));
  const domainMin = Math.min(...allMs);
  const domainMax = Math.max(domainMin + 1000, Math.max(...allMs));
  const domainSpan = domainMax - domainMin;

  const pct = (ms: number) => ((ms - domainMin) / domainSpan) * 100;

  // 5 evenly-spaced ticks across the domain.
  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => domainMin + (domainSpan * i) / (tickCount - 1));

  const labelFor = (p: Participant) => p.displayName ?? p.userId ?? p.extension;

  return (
    <div
      // Nested inside DetailDrawer's own click-to-close overlay — stop
      // propagation here too, or clicking this backdrop would cascade into
      // closing the drawer underneath it as well.
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,22,32,0.38)",
        zIndex: 50,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1100px, 100%)",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          background: C.surface,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(15,22,32,0.3)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Interaction timeline</div>
            <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2, fontFamily: MONO }}>
              {record.callId}
            </div>
            {record.interactionStartTime &&
              record.interactionEndTime &&
              (record.interactionStartTime !== record.callStartTime ||
                record.interactionEndTime !== record.callEndTime) && (
                <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 4 }}>
                  This leg is part of a longer interaction: {fmt(record.interactionStartTime)} –{" "}
                  {fmt(record.interactionEndTime)}
                </div>
              )}
          </div>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              fontSize: 22,
              cursor: "pointer",
              color: C.textMuted,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: "16px 20px", overflow: "auto", flex: 1 }}>
          {/* Legend — identity is never color-only. */}
          <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
            {(Object.keys(SEGMENT_STYLE) as SegmentKind[]).map((k) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    background: SEGMENT_STYLE[k].color,
                  }}
                />
                <span style={{ color: C.textMid }}>{SEGMENT_STYLE[k].label}</span>
              </div>
            ))}
          </div>

          <div style={{ minWidth: 640 }}>
            {rows.map((row, ri) => (
              <div
                key={row.participant.participantId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  borderTop: ri === 0 ? `1px solid ${C.border}` : "none",
                  borderBottom: `1px solid ${C.border}`,
                  padding: "8px 0",
                }}
              >
                <div style={{ width: 180, flexShrink: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Pill fg={C.accentDeep} bg={C.accentSoft}>
                      {row.participant.role.replace(/_/g, " ")}
                    </Pill>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 4 }}>
                    {labelFor(row.participant)}
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>
                    {mediaGlyph[record.mediaType]} {record.mediaType.replace(/_/g, " ")}
                  </div>
                </div>
                <div style={{ flex: 1, position: "relative", height: 28 }}>
                  {row.segments.map((seg, si) => {
                    const left = pct(seg.startMs);
                    const width = Math.max(pct(seg.endMs) - left, 0.5);
                    const isHovered = hover?.row === ri && hover?.seg === si;
                    const showLabel = width >= 8; // ~8% of track width clears a short label comfortably
                    return (
                      <div
                        key={si}
                        tabIndex={0}
                        onMouseEnter={() => setHover({ row: ri, seg: si })}
                        onMouseLeave={() => setHover((v) => (v?.row === ri && v?.seg === si ? null : v))}
                        onFocus={() => setHover({ row: ri, seg: si })}
                        onBlur={() => setHover((v) => (v?.row === ri && v?.seg === si ? null : v))}
                        style={{
                          position: "absolute",
                          left: `${left}%`,
                          width: `${width}%`,
                          top: 2,
                          height: 24,
                          background: SEGMENT_STYLE[seg.kind].color,
                          borderRadius: 4,
                          outline: isHovered ? `2px solid ${C.ink}` : "none",
                          outlineOffset: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "visible",
                          cursor: "pointer",
                        }}
                      >
                        {showLabel && (
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 650,
                              color: "#fff",
                              padding: "0 6px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {SEGMENT_STYLE[seg.kind].label}
                          </span>
                        )}
                        {isHovered && (
                          <TimelineTooltip
                            label={labelFor(row.participant)}
                            kind={seg.kind}
                            startMs={seg.startMs}
                            endMs={seg.endMs}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Shared time axis */}
            <div style={{ display: "flex", position: "relative", height: 20, marginTop: 6 }}>
              <div style={{ width: 180, flexShrink: 0 }} />
              <div style={{ flex: 1, position: "relative" }}>
                {ticks.map((t, i) => (
                  <span
                    key={i}
                    style={{
                      position: "absolute",
                      left: `${pct(t)}%`,
                      transform:
                        i === 0 ? "translateX(0)" : i === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
                      fontSize: 11,
                      color: C.textMuted,
                      fontFamily: MONO,
                    }}
                  >
                    {fmtTimeOnly(new Date(t).toISOString())}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Audit log modal ──────────────────────────────────────────────────────────
// Unlike Users/API keys (small inline lists in the ⋯ dropdown), this browses
// what can be thousands of rows, so it gets a real overlay with pagination —
// same treatment as IngestModal/ExpandModal — reusing the generic Pager
// component (already shaped around the shared Pagination type, not tied to
// CallRecord) rather than building new pagination controls.
function statusStyle(code: number): { fg: string; bg: string } {
  if (code >= 500) return { fg: C.rose, bg: C.roseSoft };
  if (code >= 400) return { fg: C.amber, bg: C.amberSoft };
  if (code >= 200 && code < 300) return { fg: C.teal, bg: C.tealSoft };
  return { fg: C.textMid, bg: C.surfaceDeep };
}

function actorLabel(e: AuditLogEntry): string {
  switch (e.actorType) {
    case "user":
      return e.actorId ?? "user";
    case "ingest_key":
      return "ingest key";
    case "admin_key":
      return "admin key";
    default:
      return "anonymous";
  }
}

interface AuditQuery {
  page: number;
  pageSize: number;
  actorId: string;
  method: string;
  pathPrefix: string;
  startTime: string;
  endTime: string;
}

function AuditLogModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [actorId, setActorId] = useState("");
  const [method, setMethod] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [exporting, setExporting] = useState(false);

  // Every call site passes fully-resolved values rather than reading filter
  // state from closure — setState is async, so e.g. clearFilters() calling
  // this right after setActorId("") would otherwise still see the old value.
  const runQuery = async (q: AuditQuery) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.auditLog.list({
        actorId: q.actorId || undefined,
        method: q.method || undefined,
        pathPrefix: q.pathPrefix || undefined,
        startTime: q.startTime ? localInputToIso(q.startTime) : undefined,
        endTime: q.endTime ? localInputToIso(q.endTime) : undefined,
        page: q.page,
        pageSize: q.pageSize,
      });
      setEntries(res.data);
      setPagination(res.pagination);
      setPage(q.page);
      setPageSize(q.pageSize);
    } catch (e: any) {
      setError(e.message ?? "Failed to load audit log");
      setEntries([]);
      setPagination(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runQuery({ page: 1, pageSize, actorId, method, pathPrefix, startTime, endTime });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = () =>
    runQuery({ page: 1, pageSize, actorId, method, pathPrefix, startTime, endTime });

  const clearFilters = () => {
    setActorId("");
    setMethod("");
    setPathPrefix("");
    setStartTime("");
    setEndTime("");
    runQuery({ page: 1, pageSize, actorId: "", method: "", pathPrefix: "", startTime: "", endTime: "" });
  };

  // Exports every entry matching the current filters (all pages, not just the
  // visible one) — same pattern as the records table's own export.
  const fetchAllMatching = async (): Promise<AuditLogEntry[]> => {
    const base = {
      actorId: actorId || undefined,
      method: method || undefined,
      pathPrefix: pathPrefix || undefined,
      startTime: startTime ? localInputToIso(startTime) : undefined,
      endTime: endTime ? localInputToIso(endTime) : undefined,
      pageSize: 500,
    };
    const first = await api.auditLog.list({ ...base, page: 1 });
    const all = [...first.data];
    for (let p = 2; p <= first.pagination.totalPages; p++) {
      const res = await api.auditLog.list({ ...base, page: p });
      all.push(...res.data);
    }
    return all;
  };

  const handleExport = async (format: "csv" | "json") => {
    setExporting(true);
    setError(null);
    try {
      const all = await fetchAllMatching();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      if (format === "csv") {
        downloadBlob(`audit-log-${stamp}.csv`, auditLogToCsv(all), "text/csv;charset=utf-8");
      } else {
        downloadBlob(`audit-log-${stamp}.json`, JSON.stringify(all, null, 2), "application/json");
      }
    } catch (e: any) {
      setError(e.message ?? "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: "7px 9px",
    borderRadius: 7,
    border: `1px solid ${C.border}`,
    background: C.surface,
    fontSize: 12.5,
    color: C.ink,
    fontFamily: SANS,
    outline: "none",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.textMuted,
    fontWeight: 700,
    marginBottom: 4,
    display: "block",
  };
  const head: React.CSSProperties = {
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.textMuted,
    fontWeight: 700,
    textAlign: "left",
    padding: "0 10px 8px 0",
  };
  const cell: React.CSSProperties = {
    padding: "8px 10px 8px 0",
    fontSize: 12.5,
    borderTop: `1px solid ${C.border}`,
    verticalAlign: "top",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,22,32,0.38)",
        zIndex: 50,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(960px, 100%)",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          background: C.surface,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(15,22,32,0.3)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Audit log</div>
            <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>
              Every query, ingest, and admin action — who (or what), when, and the result.
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            <ExportMenu busy={exporting} onExport={handleExport} />
            <button
              onClick={onClose}
              style={{
                border: "none",
                background: "transparent",
                fontSize: 22,
                cursor: "pointer",
                color: C.textMuted,
              }}
            >
              ×
            </button>
          </div>
        </div>

        <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <label style={labelStyle}>Actor</label>
              <input
                type="text"
                placeholder="username"
                value={actorId}
                onChange={(e) => setActorId(e.target.value)}
                style={{ ...inputStyle, width: 130 }}
              />
            </div>
            <div>
              <label style={labelStyle}>Method</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                style={{ ...inputStyle, width: 100 }}
              >
                <option value="">All</option>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Path starts with</label>
              <input
                type="text"
                placeholder="/api/cdr/v1/calls"
                value={pathPrefix}
                onChange={(e) => setPathPrefix(e.target.value)}
                style={{ ...inputStyle, width: 180 }}
              />
            </div>
            <div>
              <label style={labelStyle}>From</label>
              <input
                type="datetime-local"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>To</label>
              <input
                type="datetime-local"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                style={inputStyle}
              />
            </div>
            <button
              onClick={applyFilters}
              style={{
                padding: "8px 14px",
                borderRadius: 7,
                border: "none",
                background: C.ink,
                color: "#fff",
                fontSize: 12.5,
                fontWeight: 650,
                cursor: "pointer",
              }}
            >
              Apply
            </button>
            <button
              onClick={clearFilters}
              style={{
                padding: "8px 14px",
                borderRadius: 7,
                border: `1px solid ${C.border}`,
                background: C.surface,
                color: C.textMid,
                fontSize: 12.5,
                fontWeight: 650,
                cursor: "pointer",
              }}
            >
              Clear
            </button>
          </div>
        </div>

        <div style={{ padding: "14px 20px", overflowY: "auto", flex: 1 }}>
          {error && (
            <div
              style={{
                marginBottom: 12,
                padding: "10px 12px",
                borderRadius: 8,
                background: C.roseSoft,
                color: C.rose,
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
          {loading ? (
            <div style={{ fontSize: 13, color: C.textMuted, padding: "20px 0" }}>Loading…</div>
          ) : !entries || entries.length === 0 ? (
            <div style={{ fontSize: 13, color: C.textMuted, padding: "20px 0" }}>
              No matching audit entries.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={head}>Time</th>
                  <th style={head}>Actor</th>
                  <th style={head}>Request</th>
                  <th style={head}>Status</th>
                  <th style={{ ...head, textAlign: "right" }}>Records</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const st = statusStyle(e.statusCode);
                  return (
                    <tr key={e.id}>
                      <td style={{ ...cell, fontFamily: MONO, color: C.textMid, whiteSpace: "nowrap" }}>
                        {fmt(e.occurredAt)}
                      </td>
                      <td style={cell}>
                        <span
                          style={{
                            fontWeight: 600,
                            color: e.actorType === "anonymous" ? C.rose : C.ink,
                          }}
                        >
                          {actorLabel(e)}
                        </span>
                        {e.params?.username != null && e.actorType === "anonymous" && (
                          <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>
                            tried: {String(e.params.username)}
                          </div>
                        )}
                      </td>
                      <td style={{ ...cell, fontFamily: MONO }}>
                        <span style={{ color: C.accentDeep, fontWeight: 650 }}>{e.method}</span>{" "}
                        {e.path}
                      </td>
                      <td style={cell}>
                        <Pill fg={st.fg} bg={st.bg}>
                          {e.statusCode}
                        </Pill>
                      </td>
                      <td style={{ ...cell, textAlign: "right", fontFamily: MONO, color: C.textMid }}>
                        {e.recordCount ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {pagination && pagination.totalRecords > 0 && (
            <Pager
              pagination={pagination}
              pageSize={pageSize}
              onPageSizeChange={(n) =>
                runQuery({ page: 1, pageSize: n, actorId, method, pathPrefix, startTime, endTime })
              }
              onPrev={() =>
                runQuery({
                  page: Math.max(1, page - 1),
                  pageSize,
                  actorId,
                  method,
                  pathPrefix,
                  startTime,
                  endTime,
                })
              }
              onNext={() =>
                runQuery({
                  page: Math.min(pagination.totalPages, page + 1),
                  pageSize,
                  actorId,
                  method,
                  pathPrefix,
                  startTime,
                  endTime,
                })
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Ingest modal ─────────────────────────────────────────────────────────────
function IngestModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState(SAMPLE_INGEST);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const parsed = JSON.parse(text);
      const res = await api.ingest(parsed, apiKey || undefined);
      setMsg({
        ok: true,
        text: `Accepted ${res.accepted} · created ${res.created} · updated ${res.updated}`,
      });
      setTimeout(onDone, 900);
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Failed to ingest" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,22,32,0.38)",
        zIndex: 50,
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(680px, 100%)",
          background: C.surface,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(15,22,32,0.3)",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Ingest call records</div>
            <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>
              POST a single record or an array — validated against the standard,
              upserted by callId.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              fontSize: 22,
              cursor: "pointer",
              color: C.textMuted,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 20 }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            style={{
              width: "100%",
              height: 260,
              fontFamily: MONO,
              fontSize: 12.5,
              lineHeight: 1.5,
              padding: 12,
              borderRadius: 10,
              border: `1px solid ${C.border}`,
              background: C.surfaceAlt,
              color: C.ink,
              resize: "vertical",
              outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
            <input
              type="text"
              placeholder="X-API-Key (only if the server requires one)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={{
                flex: 1,
                padding: "9px 11px",
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                fontSize: 13,
                fontFamily: MONO,
                outline: "none",
              }}
            />
            <button
              onClick={submit}
              disabled={busy}
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                border: "none",
                background: busy ? C.borderStrong : C.accent,
                color: "#fff",
                fontSize: 13.5,
                fontWeight: 650,
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "Sending…" : "Ingest"}
            </button>
          </div>
          {msg && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 8,
                fontSize: 13,
                background: msg.ok ? C.tealSoft : C.roseSoft,
                color: msg.ok ? C.teal : C.rose,
              }}
            >
              {msg.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const SAMPLE_INGEST = JSON.stringify(
  {
    callId: "demo-" + Math.random().toString(36).slice(2, 10),
    sourcePlatformId: "switch-lon-01",
    sourcePlatformType: "Cisco UCM",
    callStartTime: "2024-06-01T15:00:05.000Z",
    callEndTime: "2024-06-01T15:03:20.000Z",
    lastUpdateTime: "2024-06-01T15:03:20.000Z",
    durationSeconds: 195,
    callState: "ended",
    callDirection: "inbound",
    callType: "peer_to_peer",
    mediaType: "voice",
    participants: [
      { participantId: "p1", role: "caller", extension: "+442071234567", group: "external" },
      {
        participantId: "p2",
        role: "callee",
        extension: "2210",
        userId: "aturner",
        displayName: "Alex Turner",
        group: "customer-services-london",
        recordingConfig: "record",
      },
    ],
    events: [
      { eventTime: "2024-06-01T15:00:00.000Z", eventType: "ringing", participantId: "p2" },
      { eventTime: "2024-06-01T15:00:05.000Z", eventType: "connected" },
      { eventTime: "2024-06-01T15:03:20.000Z", eventType: "disconnected", participantId: "p1" },
    ],
    cloudRecording: { recordingStatus: "recorded", recordingMethod: "automatic" },
  },
  null,
  2
);
