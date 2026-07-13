import { callRecordSchema, type CallRecordInput } from "../schemas/cdr";
import { ingestRecords } from "../services/ingestService";

/**
 * Generates rich, schema-conformant demo call records spanning the last 6
 * months — unlike seedExamples() (5 fixed scenarios from the standard, run
 * automatically on first boot), this is a deliberate, manually-run "give me a
 * lot of realistic data" script (npm run seed:demo). It deliberately touches
 * every field in the schema (not just the common ones), including device
 * info, interaction-level timing, hunt numbers, wrap-up notes, recording
 * download paths, vendor-specific fields, participant join/leave/slot/handset
 * detail, and a broad spread of event/role/enum values — so every dashboard
 * feature (Insights charts, drill-across, advanced filter, etc.) has
 * something real to show.
 *
 * Every record is validated against callRecordSchema before ingest, so this
 * doubles as a generator-correctness check the same way seedExamples() does
 * for the standard's own examples.
 */

const NOW = () => new Date();
const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000;
// Mutable so seedDemoData()'s caller (e.g. seedDemo12mo.ts) can widen the
// spread and tag callIds distinctly, without threading params through every
// one of the ~20 make*() scenario functions below that call randTime()/
// newCallId() internally. Safe to mutate module-level state here: unlike
// seedExamples()/seedAdmin(), seedDemoData() is never called during normal
// server boot (see index.ts) — only from a standalone script invocation.
let TIME_WINDOW_MS = SIX_MONTHS_MS;
let ID_PREFIX = "demo5k";

// (sourcePlatformId, sourcePlatformType, tenantId) — matches the standard's
// own seeded examples so scoping/filtering demos stay consistent.
const PLATFORMS: [string, string, string][] = [
  ["switch-lon-01", "Cisco UCM", "tenant-london"],
  ["switch-lon-02", "Avaya Aura", "tenant-london"],
  ["switch-lon-03", "Microsoft Teams", "tenant-london"],
  ["switch-nyc-01", "Genesys Cloud", "tenant-nyc"],
  ["switch-nyc-02", "Zoom Phone", "tenant-nyc"],
];

interface Agent {
  userId: string;
  name: string;
  ext: string;
}

const AGENTS: Record<string, Agent[]> = {
  "customer-services-london": [
    { userId: "hclarke", name: "Harriet Clarke", ext: "2231" },
    { userId: "tward", name: "Tom Ward", ext: "2232" },
    { userId: "rpatel", name: "Riya Patel", ext: "2233" },
    { userId: "sday", name: "Sian Day", ext: "2234" },
  ],
  "customer-services-specialist": [
    { userId: "nomara", name: "Niamh O'Mara", ext: "2241" },
    { userId: "jsingh", name: "Jaspreet Singh", ext: "2242" },
  ],
  "billing-london": [
    { userId: "dcohen", name: "Dan Cohen", ext: "2311" },
    { userId: "efoster", name: "Ella Foster", ext: "2312" },
  ],
  "billing-nyc": [
    { userId: "mrossi", name: "Marco Rossi", ext: "3311" },
    { userId: "kbrooks", name: "Kayla Brooks", ext: "3312" },
  ],
  "support-nyc": [
    { userId: "achen", name: "Amy Chen", ext: "3221" },
    { userId: "jmartin", name: "Jake Martin", ext: "3222" },
    { userId: "lwong", name: "Leo Wong", ext: "3223" },
    { userId: "rortiz", name: "Rosa Ortiz", ext: "3224" },
  ],
  "technical-specialists": [
    { userId: "pvance", name: "Priya Vance", ext: "3401" },
    { userId: "sokafor", name: "Sam Okafor", ext: "3402" },
  ],
  "sales-nyc": [
    { userId: "bthomas", name: "Bea Thomas", ext: "3111" },
    { userId: "cgarcia", name: "Carlos Garcia", ext: "3112" },
  ],
  "product-nyc": [{ userId: "wzhang", name: "Wei Zhang", ext: "3511" }],
  "design-nyc": [{ userId: "ftanaka", name: "Fumi Tanaka", ext: "3611" }],
};
const GROUPS = Object.keys(AGENTS);

const SUPERVISORS: Record<string, Agent> = {
  "customer-services-london": { userId: "gmoore", name: "Grace Moore", ext: "2299" },
  "support-nyc": { userId: "dsilva", name: "Diego Silva", ext: "3299" },
  "billing-nyc": { userId: "eross", name: "Erin Ross", ext: "3399" },
};

const QUEUES: [string, string][] = [
  ["support-queue-nyc", "support-nyc"],
  ["billing-queue-nyc", "billing-nyc"],
  ["ACD-Billing-London", "billing-london"],
  ["sales-queue-nyc", "sales-nyc"],
  ["technical-queue-nyc", "technical-specialists"],
];

const IVRS = [
  "ivr-main > option-1-sales",
  "ivr-main > option-2-billing > option-1-account-query",
  "ivr-main > option-2-billing > option-2-payments",
  "ivr-main > option-3-support > option-2-technical",
  "ivr-main > option-4-general",
];

const HUNT_NUMBERS = [
  "+442079460000", "+442073580099", "+18005550123", "+18005550199",
];

const EXTERNAL_NUMBERS = [
  "+442079460077", "+442079460091", "+442073580012", "+447700900123",
  "+13125550100", "+13125550142", "+12125550187", "+16465550199",
  "+442079460055", "+13125550178",
];

const DEVICE_MODELS: [string, string][] = [
  // [model, softwareVersion]
  ["Cisco 8865", "14.2.1"],
  ["Yealink T54W", "96.86.0.35"],
  ["Poly CCX 500", "6.1.2"],
  ["Zoom Phone Desktop Client", "5.17.5"],
  ["Microsoft Teams Desktop", "1.7.00.5876"],
  ["Avaya J179", "4.0.9"],
];
const AUDIO_CODECS = ["G.711", "G.722", "Opus"];
const VIDEO_CODECS = ["H.264", "VP8", "VP9"];

const WRAPUP_CODES: [string, string][] = [
  // [code, note]
  ["resolved", "Issue resolved on first contact."],
  ["follow-up", "Follow-up email scheduled with customer."],
  ["escalated", "Escalated to specialist team for further review."],
  ["info-only", "Customer requested information only, no action needed."],
  ["billing-dispute", "Billing dispute logged, case number issued."],
];

const VENDOR_CAMPAIGNS = ["summer-promo-2026", "renewal-outreach", "support-inbound", "vip-care"];

let idCounter = 0;
function newCallId(): string {
  idCounter += 1;
  return `${ID_PREFIX}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickAgent(group?: string): { group: string; agent: Agent } {
  const g = group ?? pick(GROUPS);
  return { group: g, agent: pick(AGENTS[g]) };
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Biases toward business hours (8am-6pm) on weekdays, ~80% of the time —
// matches how real call volume actually distributes, so the throughput chart
// looks like a real contact center instead of uniform noise.
function randTime(): Date {
  const start = NOW().getTime() - TIME_WINDOW_MS;
  const t = new Date(start + Math.random() * TIME_WINDOW_MS);
  if (Math.random() < 0.8) {
    t.setHours(randInt(8, 17), randInt(0, 59), randInt(0, 59), randInt(0, 999));
    if (t.getDay() === 0 || t.getDay() === 6) t.setDate(t.getDate() - (t.getDay() === 0 ? 2 : 1));
  }
  return t;
}

function iso(t: Date): string {
  return t.toISOString();
}

function deviceFor(mediaType: string) {
  const [model, softwareVersion] = pick(DEVICE_MODELS);
  return {
    deviceId: `dev-${Math.random().toString(36).slice(2, 10)}`,
    device: {
      model,
      softwareVersion,
      macAddress: Array.from({ length: 6 }, () =>
        randInt(0, 255).toString(16).padStart(2, "0")
      ).join(":"),
      ipAddress: `10.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`,
      audioCodec: pick(AUDIO_CODECS),
      ...(mediaType === "video" ? { videoCodec: pick(VIDEO_CODECS) } : {}),
    },
  };
}

function qosBlock(poor = false) {
  const mosScore = poor
    ? Math.round(rand(1.2, 2.8) * 10) / 10
    : Math.round(Math.min(5, Math.max(1, gauss(4.2, 0.4))) * 10) / 10;
  return {
    mosScore,
    latencyMs: poor ? randInt(150, 400) : randInt(15, 90),
    jitterMs: poor ? randInt(25, 90) : randInt(2, 20),
    packetLossPercent: Math.round((poor ? rand(2, 9) : rand(0, 1.2)) * 10) / 10,
    packetsTotal: randInt(2000, 60000),
  };
}

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}
function gauss(mean: number, sd: number): number {
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function vendorFields(): Record<string, unknown> | undefined {
  if (Math.random() > 0.3) return undefined;
  return {
    pbxCallId: `pbx-${Math.random().toString(36).slice(2, 12)}`,
    campaignId: pick(VENDOR_CAMPAIGNS),
  };
}

function externalParticipant(pid: string): CallRecordInput["participants"][number] {
  return {
    participantId: pid,
    role: "caller",
    extension: pick(EXTERNAL_NUMBERS),
    group: "external",
    recordingConfig: "not_applicable",
  };
}

function agentParticipant(
  pid: string,
  group: string,
  agent: Agent,
  opts: {
    role?: CallRecordInput["participants"][number]["role"];
    mediaType?: string;
    joinTime?: Date;
    leaveTime?: Date;
    slotNumber?: string;
    handsetInfo?: string;
    withDevice?: boolean;
  } = {}
): CallRecordInput["participants"][number] {
  const recordingConfig = pick(["record", "record", "record", "do_not_record", "unknown"] as const);
  return {
    participantId: pid,
    role: opts.role ?? "callee",
    extension: agent.ext,
    userId: agent.userId,
    displayName: agent.name,
    group,
    recordingConfig,
    ...(opts.withDevice !== false ? deviceFor(opts.mediaType ?? "voice") : {}),
    ...(opts.joinTime ? { joinTime: iso(opts.joinTime) } : {}),
    ...(opts.leaveTime ? { leaveTime: iso(opts.leaveTime) } : {}),
    ...(opts.slotNumber ? { slotNumber: opts.slotNumber } : {}),
    ...(opts.handsetInfo ? { handsetInfo: opts.handsetInfo } : {}),
  };
}

interface BaseOpts {
  mediaType?: CallRecordInput["mediaType"];
  callState?: CallRecordInput["callState"];
  callType?: CallRecordInput["callType"];
  direction?: CallRecordInput["callDirection"];
  scenario: string;
  interactionSpansLegs?: { start: Date; end: Date };
}

function baseFields(callId: string, start: Date, durationS: number, opts: BaseOpts): CallRecordInput {
  const [sourcePlatformId, sourcePlatformType, tenantId] = pick(PLATFORMS);
  const callState = opts.callState ?? "ended";
  const end = callState === "abandoned" && durationS === 0 ? undefined : new Date(start.getTime() + durationS * 1000);
  const huntNumber = Math.random() < 0.4 ? pick(HUNT_NUMBERS) : undefined;

  return {
    callId,
    tenantId,
    sourcePlatformId,
    sourcePlatformType,
    interactionStartTime: iso(opts.interactionSpansLegs?.start ?? start),
    callStartTime: iso(start),
    callEndTime: end ? iso(end) : undefined,
    interactionEndTime: opts.interactionSpansLegs
      ? iso(opts.interactionSpansLegs.end)
      : end
      ? iso(end)
      : undefined,
    lastUpdateTime: end ? iso(end) : iso(start),
    durationSeconds: callState === "ended" ? durationS : undefined,
    callState,
    callDirection: opts.direction ?? pick(["inbound", "inbound", "inbound", "outbound"] as const),
    callType: opts.callType ?? "peer_to_peer",
    mediaType: opts.mediaType ?? "voice",
    callSource: huntNumber ? { huntNumber } : undefined,
    participants: [],
    events: [],
    vendorSpecificFields: vendorFields(),
    _scenario: opts.scenario,
  };
}

function withWrapUp(r: CallRecordInput): CallRecordInput {
  if (Math.random() < 0.7) {
    const [wrapUpCode, wrapUpNotes] = pick(WRAPUP_CODES);
    r.wrapUpInfo = { wrapUpCode, wrapUpNotes, wrapUpDurationSeconds: randInt(10, 90) };
  }
  return r;
}

const TRANSCRIPTION_PROVIDERS = ["AWS Transcribe", "Azure Speech", "Whisper", "Google Speech-to-Text"];
const TRANSCRIPT_LANGUAGES = ["en-GB", "en-US", "es-ES", "fr-FR"];

// Transcription only ever appears alongside a recording (it's generated from
// one — the schema's own transcription.recordingId correlates the two), and
// not every recording gets transcribed, matching real-world coverage.
function withRecording(r: CallRecordInput, callId: string): CallRecordInput {
  if (Math.random() < 0.6) {
    const recordingId = `rec-${callId}`;
    r.cloudRecording = {
      recordingStatus: "recorded",
      recordingMethod: pick(["automatic", "manual", "on_demand"] as const),
      recordingId,
      mediaName: `${callId}.wav`,
      downloadPath: `https://recordings.internal.example/${callId}.wav`,
    };
    if (Math.random() < 0.55) {
      r.transcription = {
        transcriptionStatus: pick(["transcribed", "transcribed", "transcribed", "partial"] as const),
        transcriptionMethod: pick(["automatic", "automatic", "manual", "on_demand"] as const),
        transcriptId: `txn-${callId}`,
        recordingId,
        provider: pick(TRANSCRIPTION_PROVIDERS),
        language: pick(TRANSCRIPT_LANGUAGES),
        confidenceScore: Math.round(rand(0.72, 0.99) * 100) / 100,
        wordCount: randInt(80, 2200),
        redacted: Math.random() < 0.3,
        mediaName: `${callId}.json`,
        downloadPath: `https://transcripts.internal.example/${callId}.json`,
      };
    }
  }
  return r;
}

// ─── Scenario generators ────────────────────────────────────────────────────

function makeSimple(): CallRecordInput {
  const { group, agent } = pickAgent();
  const start = randTime();
  const duration = randInt(30, 900);
  const callId = newCallId();
  const r = baseFields(callId, start, duration, { scenario: "Direct call — rich demo data" });
  r.participants = [
    externalParticipant("p1"),
    agentParticipant("p2", group, agent, { joinTime: start, leaveTime: new Date(start.getTime() + duration * 1000) }),
  ];
  r.events = [
    { eventTime: iso(start), eventType: "ringing", participantId: "p2" },
    { eventTime: iso(new Date(start.getTime() + 4000)), eventType: "connected" },
    {
      eventTime: iso(new Date(start.getTime() + duration * 1000)),
      eventType: "disconnected",
      participantId: "p1",
      detail: "Caller ended the call",
    },
  ];
  r.qos = qosBlock(Math.random() < 0.08);
  return withRecording(withWrapUp(r), callId);
}

function makeVideo(): CallRecordInput {
  const { group, agent } = pickAgent(pick(["design-nyc", "product-nyc", "sales-nyc"]));
  const start = randTime();
  const duration = randInt(300, 2700);
  const callId = newCallId();
  const r = baseFields(callId, start, duration, {
    mediaType: "video",
    callType: "meeting",
    scenario: "Video meeting — rich demo data",
  });
  r.participants = [
    agentParticipant("p1", group, agent, { role: "caller", mediaType: "video" }),
    { ...externalParticipant("p2"), role: "callee" },
  ];
  r.qos = qosBlock(Math.random() < 0.1);
  return r;
}

function makeNonVoice(): CallRecordInput {
  const mediaType = pick(["chat", "instant_message", "email", "unknown"] as const);
  const { group, agent } = pickAgent();
  const start = randTime();
  const duration = randInt(60, 1800);
  const callId = newCallId();
  const r = baseFields(callId, start, duration, { mediaType, scenario: `${mediaType} — rich demo data` });
  r.participants = [externalParticipant("p1"), agentParticipant("p2", group, agent, { withDevice: false })];
  return r;
}

function makeVoicemail(): CallRecordInput {
  const { group, agent } = pickAgent();
  const start = randTime();
  const duration = randInt(10, 90);
  const callId = newCallId();
  const r = baseFields(callId, start, duration, { callType: "voicemail", scenario: "Voicemail — rich demo data" });
  r.participants = [
    externalParticipant("p1"),
    { participantId: "p2", role: "voicemail", extension: agent.ext, group },
  ];
  r.events = [{ eventTime: iso(start), eventType: "voicemail", participantId: "p2", detail: "Routed to voicemail" }];
  r.cloudRecording = {
    recordingStatus: "recorded",
    recordingMethod: "automatic",
    recordingId: `vm-${callId}`,
    mediaName: "voicemail.wav",
    downloadPath: `https://recordings.internal.example/voicemail/${callId}.wav`,
  };
  return r;
}

function makeMissed(): CallRecordInput {
  const { group, agent } = pickAgent();
  const start = randTime();
  const callId = newCallId();
  const r = baseFields(callId, start, 0, { callState: "missed", scenario: "Missed call — rich demo data" });
  r.durationSeconds = undefined;
  r.callEndTime = iso(new Date(start.getTime() + randInt(15, 45) * 1000));
  r.participants = [externalParticipant("p1"), agentParticipant("p2", group, agent, { withDevice: false })];
  r.events = [
    { eventTime: iso(start), eventType: "ringing", participantId: "p2" },
    { eventTime: r.callEndTime, eventType: "missed", participantId: "p2", detail: "No answer" },
  ];
  return r;
}

function makeIvrOnly(): CallRecordInput {
  const ivrInfo = pick(IVRS);
  const { group, agent } = pickAgent();
  const start = randTime();
  const ivrTime = randInt(20, 120);
  const talk = randInt(60, 800);
  const callId = newCallId();
  const r = baseFields(callId, start, ivrTime + talk, { scenario: "IVR-routed call — rich demo data" });
  r.callSource = { ...(r.callSource ?? {}), ivrInfo, timeInIvrSeconds: ivrTime };
  r.participants = [
    externalParticipant("p1"),
    { participantId: "ivr1", role: "ivr", extension: "ivr-main", group: "ivr-system" },
    agentParticipant("p2", group, agent),
  ];
  r.events = [
    {
      eventTime: iso(start),
      eventType: "ivr_entry",
      participantId: "ivr1",
      metadata: { dnis: pick(HUNT_NUMBERS) },
    },
    {
      eventTime: iso(new Date(start.getTime() + ivrTime * 1000)),
      eventType: "ivr_exit",
      participantId: "ivr1",
      metadata: { selectedOption: randInt(1, 4) },
    },
    { eventTime: iso(new Date(start.getTime() + (ivrTime + 2) * 1000)), eventType: "connected" },
    { eventTime: iso(new Date(start.getTime() + (ivrTime + talk) * 1000)), eventType: "disconnected" },
  ];
  r.qos = qosBlock(Math.random() < 0.08);
  return withWrapUp(r);
}

function makeQueueOnly(): CallRecordInput {
  const [queueInfo, group] = pick(QUEUES);
  const { agent } = pickAgent(group);
  const start = randTime();
  const queueTime = randInt(15, 400);
  const talk = randInt(60, 900);
  const callId = newCallId();
  const r = baseFields(callId, start, queueTime + talk, { scenario: "Queue-routed call — rich demo data" });
  r.callSource = { ...(r.callSource ?? {}), queueInfo, timeInQueueSeconds: queueTime };
  r.participants = [
    externalParticipant("p1"),
    { participantId: "q1", role: "queue", extension: queueInfo, group },
    agentParticipant("p2", group, agent),
  ];
  const queuePosition = randInt(2, 8);
  r.events = [
    {
      eventTime: iso(start),
      eventType: "queue_entry",
      participantId: "q1",
      metadata: { queuePosition },
    },
    {
      eventTime: iso(new Date(start.getTime() + queueTime * 1000)),
      eventType: "queue_exit",
      participantId: "q1",
      metadata: { queuePosition: 1 },
    },
    { eventTime: iso(new Date(start.getTime() + (queueTime + 2) * 1000)), eventType: "connected" },
    { eventTime: iso(new Date(start.getTime() + (queueTime + talk) * 1000)), eventType: "disconnected" },
  ];
  r.qos = qosBlock(Math.random() < 0.1);
  return withWrapUp(r);
}

function makeIvrAndQueue(): CallRecordInput {
  const ivrInfo = pick(IVRS);
  const [queueInfo, group] = pick(QUEUES);
  const { agent } = pickAgent(group);
  const start = randTime();
  const ivrTime = randInt(20, 90);
  const queueTime = randInt(15, 350);
  const talk = randInt(90, 1000);
  const callId = newCallId();
  const r = baseFields(callId, start, ivrTime + queueTime + talk, {
    scenario: "IVR + queue-routed call — rich demo data",
  });
  r.callSource = { ...(r.callSource ?? {}), ivrInfo, timeInIvrSeconds: ivrTime, queueInfo, timeInQueueSeconds: queueTime };
  r.participants = [
    externalParticipant("p1"),
    { participantId: "ivr1", role: "ivr", extension: "ivr-main", group: "ivr-system" },
    { participantId: "q1", role: "queue", extension: queueInfo, group },
    agentParticipant("p2", group, agent),
  ];
  let t = start.getTime();
  const ivrExitT = t + ivrTime * 1000;
  const queueExitT = ivrExitT + queueTime * 1000;
  const queuePosition = randInt(2, 8);
  r.events = [
    {
      eventTime: iso(new Date(t)),
      eventType: "ivr_entry",
      participantId: "ivr1",
      metadata: { dnis: pick(HUNT_NUMBERS) },
    },
    {
      eventTime: iso(new Date(ivrExitT)),
      eventType: "ivr_exit",
      participantId: "ivr1",
      metadata: { selectedOption: randInt(1, 4) },
    },
    {
      eventTime: iso(new Date(ivrExitT)),
      eventType: "queue_entry",
      participantId: "q1",
      metadata: { queuePosition },
    },
    {
      eventTime: iso(new Date(queueExitT)),
      eventType: "queue_exit",
      participantId: "q1",
      metadata: { queuePosition: 1 },
    },
    { eventTime: iso(new Date(queueExitT)), eventType: "connected" },
    { eventTime: iso(new Date(start.getTime() + (ivrTime + queueTime + talk) * 1000)), eventType: "disconnected" },
  ];
  r.qos = qosBlock(Math.random() < 0.12);
  return withWrapUp(r);
}

function makeAbandoned(): CallRecordInput {
  const duringIvr = Math.random() < 0.5;
  const start = randTime();
  const callId = newCallId();
  const r = baseFields(callId, start, 0, { callState: "abandoned", scenario: "Abandoned call — rich demo data" });
  r.durationSeconds = undefined;
  if (duringIvr) {
    const ivrInfo = pick(IVRS);
    const ivrTime = randInt(15, 90);
    r.callSource = { ...(r.callSource ?? {}), ivrInfo, timeInIvrSeconds: ivrTime };
    r.participants = [
      externalParticipant("p1"),
      { participantId: "ivr1", role: "ivr", extension: "ivr-main", group: "ivr-system" },
    ];
    r.callEndTime = iso(new Date(start.getTime() + ivrTime * 1000));
    r.events = [
      {
        eventTime: iso(start),
        eventType: "ivr_entry",
        participantId: "ivr1",
        metadata: { dnis: pick(HUNT_NUMBERS) },
      },
      { eventTime: r.callEndTime, eventType: "disconnected", participantId: "p1", detail: "Caller hung up during IVR" },
    ];
  } else {
    const [queueInfo, group] = pick(QUEUES);
    const queueTime = randInt(30, 300);
    r.callSource = { ...(r.callSource ?? {}), queueInfo, timeInQueueSeconds: queueTime };
    r.participants = [
      externalParticipant("p1"),
      { participantId: "q1", role: "queue", extension: queueInfo, group },
    ];
    r.callEndTime = iso(new Date(start.getTime() + queueTime * 1000));
    r.events = [
      {
        eventTime: iso(start),
        eventType: "queue_entry",
        participantId: "q1",
        metadata: { queuePosition: randInt(2, 10) },
      },
      { eventTime: r.callEndTime, eventType: "disconnected", participantId: "p1", detail: "Caller abandoned in queue" },
    ];
  }
  return r;
}

function makeConference(): CallRecordInput {
  const n = randInt(3, 6);
  const start = randTime();
  const duration = randInt(300, 3000);
  const callId = newCallId();
  const r = baseFields(callId, start, duration, {
    callType: "conference",
    direction: "internal",
    scenario: "Multi-party conference — rich demo data",
  });
  const usedGroups = [...GROUPS].sort(() => Math.random() - 0.5).slice(0, Math.min(n, GROUPS.length));
  r.participants = usedGroups.map((g, i) => {
    const { agent } = pickAgent(g);
    const joinOffset = randInt(0, 20);
    return agentParticipant(`p${i + 1}`, g, agent, {
      role: i === 0 ? "caller" : "conference_participant",
      joinTime: new Date(start.getTime() + joinOffset * 1000),
      leaveTime: new Date(start.getTime() + duration * 1000 - randInt(0, 15) * 1000),
      slotNumber: String(i + 1),
    });
  });
  r.events = [
    { eventTime: iso(start), eventType: "conference_created", participantId: "p1" },
    ...r.participants.slice(1).map((p, i) => ({
      eventTime: iso(new Date(start.getTime() + 5 * (i + 1) * 1000)),
      eventType: "participant_join" as const,
      participantId: p.participantId,
    })),
    { eventTime: iso(new Date(start.getTime() + duration * 1000)), eventType: "disconnected" as const },
  ];
  r.qos = qosBlock(Math.random() < 0.1);
  return r;
}

// Split so both role enum values actually appear in the data: half the time
// the supervisor silently monitors (role monitor_supervisor, monitor_start/
// monitor_stop only); the other half they barge in (role barge_agent, a
// barge_in event) — otherwise the role would always get overwritten to one
// value and the other would never appear anywhere in the dataset.
function makeMonitorBarge(): CallRecordInput {
  const group = pick(Object.keys(SUPERVISORS));
  const { agent } = pickAgent(group);
  const supervisor = SUPERVISORS[group];
  const start = randTime();
  const duration = randInt(180, 900);
  const doesBarge = Math.random() < 0.5;
  const callId = newCallId();
  const r = baseFields(callId, start, duration, {
    scenario: doesBarge ? "Supervisor barge-in — rich demo data" : "Supervisor silent monitor — rich demo data",
  });
  // Barging in only makes the supervisor a real call participant from that
  // moment on — before that they're silently monitoring (monitor_start,
  // below), not "in" the call the way joinTime/the interaction timeline mean
  // it. Silent-monitor-only records have no such moment, so joinTime staying
  // at call start is correct there.
  const bargeAt = doesBarge ? randInt(30, Math.max(31, duration - 30)) : null;
  r.participants = [
    externalParticipant("p1"),
    agentParticipant("p2", group, agent, { handsetInfo: "Desk handset, headset jack 1" }),
    agentParticipant("p3", group, supervisor, {
      role: doesBarge ? "barge_agent" : "monitor_supervisor",
      joinTime: bargeAt != null ? new Date(start.getTime() + bargeAt * 1000) : start,
    }),
  ];
  const events: CallRecordInput["events"] = [
    { eventTime: iso(start), eventType: "connected" },
    { eventTime: iso(new Date(start.getTime() + 5000)), eventType: "monitor_start", participantId: "p3" },
  ];
  if (bargeAt != null) {
    events.push({
      eventTime: iso(new Date(start.getTime() + bargeAt * 1000)),
      eventType: "barge_in",
      participantId: "p3",
      detail: "Supervisor joined the call",
    });
  } else {
    events.push({
      eventTime: iso(new Date(start.getTime() + Math.max(6, duration - 5) * 1000)),
      eventType: "monitor_stop",
      participantId: "p3",
    });
  }
  events.push({ eventTime: iso(new Date(start.getTime() + duration * 1000)), eventType: "disconnected" });
  r.events = events;
  r.qos = qosBlock(Math.random() < 0.08);
  return withWrapUp(r);
}

/** Two linked records: leg1 (caller <-> agent A, transferred), leg2 (caller <-> agent B). */
function makeTransferPair(): CallRecordInput[] {
  const { group: groupA, agent: agentA } = pickAgent();
  const { group: groupB, agent: agentB } = pickAgent();
  const start = randTime();
  const leg1Duration = randInt(30, 200);
  const leg2Start = new Date(start.getTime() + leg1Duration * 1000);
  const leg2Duration = randInt(60, 700);
  const interactionEnd = new Date(leg2Start.getTime() + leg2Duration * 1000);

  const leg1Id = newCallId();
  const leg2Id = newCallId();

  const leg1 = baseFields(leg1Id, start, leg1Duration, {
    scenario: "Transfer — leg 1 — rich demo data",
    interactionSpansLegs: { start, end: interactionEnd },
  });
  leg1.relatedCallIds = [leg2Id];
  leg1.participants = [
    externalParticipant("p1"),
    agentParticipant("p2", groupA, agentA, { role: "transfer_source" }),
  ];
  leg1.events = [
    { eventTime: iso(start), eventType: "connected" },
    {
      eventTime: iso(new Date(leg2Start.getTime() - 3000)),
      eventType: "transfer_initiated",
      participantId: "p2",
      targetParticipantId: "p2",
      metadata: { reason: "specialist required" },
    },
    { eventTime: iso(leg2Start), eventType: "transfer_completed", participantId: "p2" },
  ];
  leg1.qos = qosBlock(Math.random() < 0.08);

  const leg2 = baseFields(leg2Id, leg2Start, leg2Duration, {
    scenario: "Transfer — leg 2 — rich demo data",
    interactionSpansLegs: { start, end: interactionEnd },
  });
  leg2.parentCallId = leg1Id;
  leg2.relatedCallIds = [leg1Id];
  leg2.participants = [
    externalParticipant("p1"),
    agentParticipant("p2", groupB, agentB, { role: "transfer_target" }),
  ];
  leg2.events = [
    { eventTime: iso(leg2Start), eventType: "connected" },
    {
      eventTime: iso(new Date(leg2Start.getTime() + leg2Duration * 1000)),
      eventType: "disconnected",
      participantId: "p1",
    },
  ];
  leg2.qos = qosBlock(Math.random() < 0.08);

  return [withWrapUp(leg1), withRecording(withWrapUp(leg2), leg2Id)];
}

/** Three linked records: main leg, a consultation leg, cross-referenced (mirrors the standard's own example shape). */
function makeConsultTransferTrio(): CallRecordInput[] {
  const { group: groupA, agent: agentA } = pickAgent();
  const { group: groupB, agent: agentB } = pickAgent();
  const start = randTime();
  const mainDuration = randInt(60, 300);
  const consultStart = new Date(start.getTime() + randInt(20, Math.max(21, mainDuration - 10)) * 1000);
  const consultDuration = randInt(20, 90);

  const mainId = newCallId();
  const consultId = `${mainId}-consult`;

  const main = baseFields(mainId, start, mainDuration, { scenario: "Consult transfer — main leg — rich demo data" });
  main.relatedCallIds = [consultId];
  main.participants = [
    externalParticipant("p1"),
    agentParticipant("p2", groupA, agentA, { role: "transfer_source" }),
  ];
  main.events = [
    { eventTime: iso(start), eventType: "connected" },
    { eventTime: iso(consultStart), eventType: "hold", participantId: "p1" },
    { eventTime: iso(new Date(start.getTime() + mainDuration * 1000)), eventType: "resume", participantId: "p1" },
    { eventTime: iso(new Date(start.getTime() + mainDuration * 1000)), eventType: "disconnected" },
  ];
  main.qos = qosBlock(Math.random() < 0.08);

  const consult = baseFields(consultId, consultStart, consultDuration, {
    callType: "intercom",
    direction: "internal",
    scenario: "Consult transfer — consultation leg — rich demo data",
  });
  consult.parentCallId = mainId;
  consult.relatedCallIds = [mainId];
  consult.participants = [
    agentParticipant("p2", groupA, agentA, { role: "transfer_consultation" }),
    agentParticipant("p3", groupB, agentB, { role: "transfer_consultation" }),
  ];
  consult.events = [
    { eventTime: iso(consultStart), eventType: "connected" },
    { eventTime: iso(new Date(consultStart.getTime() + consultDuration * 1000)), eventType: "disconnected" },
  ];

  return [withWrapUp(main), consult];
}

// ─── Assembly ────────────────────────────────────────────────────────────────

const PLAN: [() => CallRecordInput, number][] = [
  [makeSimple, 850],
  [makeVideo, 250],
  [makeNonVoice, 500],
  [makeVoicemail, 200],
  [makeMissed, 200],
  [makeIvrOnly, 450],
  [makeQueueOnly, 450],
  [makeIvrAndQueue, 650],
  [makeAbandoned, 350],
  [makeConference, 250],
  [makeMonitorBarge, 150],
];
const MULTI_LEG_PAIRS = 250; // -> 500 records
const CONSULT_TRIOS = 100; // -> 200 records

export async function seedDemoData(opts: { windowMs?: number; idPrefix?: string } = {}): Promise<void> {
  if (opts.windowMs != null) TIME_WINDOW_MS = opts.windowMs;
  if (opts.idPrefix != null) ID_PREFIX = opts.idPrefix;

  const records: CallRecordInput[] = [];
  for (const [fn, count] of PLAN) {
    for (let i = 0; i < count; i++) records.push(fn());
  }
  for (let i = 0; i < MULTI_LEG_PAIRS; i++) records.push(...makeTransferPair());
  for (let i = 0; i < CONSULT_TRIOS; i++) records.push(...makeConsultTransferTrio());

  // Shuffle so callIds/timestamps aren't grouped by scenario in insertion order.
  for (let i = records.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [records[i], records[j]] = [records[j], records[i]];
  }

  // Validates every record against the schema before ingest — doubles as a
  // conformance check on this generator, same as seedExamples() does for the
  // standard's own examples.
  const validated = records.map((r) => callRecordSchema.parse(r));

  console.log(`🌱  Generated ${validated.length} rich demo records — ingesting in batches of 500...`);
  const BATCH = 500;
  let created = 0;
  let updated = 0;
  for (let i = 0; i < validated.length; i += BATCH) {
    const chunk = validated.slice(i, i + BATCH);
    const results = await ingestRecords(chunk);
    created += results.filter((r) => r.action === "created").length;
    updated += results.filter((r) => r.action === "updated").length;
    console.log(`    ...${Math.min(i + BATCH, validated.length)}/${validated.length}`);
  }
  console.log(`🌱  Done — ${created} created, ${updated} updated`);
}

// Standalone runner (npm run seed:demo)
if (require.main === module) {
  seedDemoData()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Rich demo seed failed:", err);
      process.exit(1);
    });
}
