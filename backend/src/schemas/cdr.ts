import { z } from "zod";

/**
 * Zod mirror of the Open CDR Standard (cdr-schema.yaml → CallRecord and its
 * nested objects). This is the platform's gatekeeper: anything POSTed to the
 * ingest endpoint is validated against the standard before it is stored, so the
 * store only ever holds conforming records.
 *
 * Enums are kept strict on purpose — rejecting an out-of-vocabulary value is the
 * whole point of a standards-validating logger. Objects that the standard leaves
 * open (vendorSpecificFields, event metadata) use .passthrough()/.catchall().
 *
 * Spec note: CallRecord.required lists `callEndTime`, yet the field's own
 * description says its absence implies an ongoing call. Those two cannot both
 * hold, so we treat callEndTime as optional here to allow ongoing calls to be
 * logged. This divergence is flagged in the README as a spec issue to raise
 * upstream.
 *
 * Optional fields use .nullish() rather than .optional(): the standard's own
 * example records represent an absent optional field as explicit JSON `null`
 * rather than omitting the key, so the gatekeeper has to accept both.
 */

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .describe("UTC ISO-8601 timestamp");

export const deviceInfoSchema = z
  .object({
    model: z.string().nullish(),
    softwareVersion: z.string().nullish(),
    macAddress: z.string().nullish(),
    ipAddress: z.string().nullish(),
    audioCodec: z.string().nullish(),
    videoCodec: z.string().nullish(),
  })
  .passthrough();

export const participantSchema = z
  .object({
    participantId: z.string(),
    role: z.enum([
      "caller",
      "callee",
      "conference_participant",
      "transfer_source",
      "transfer_target",
      "transfer_consultation",
      "barge_agent",
      "monitor_supervisor",
      "ivr",
      "queue",
      "voicemail",
      "unknown",
    ]),
    extension: z.string(),
    userId: z.string().nullish(),
    displayName: z.string().nullish(),
    deviceId: z.string().nullish(),
    device: deviceInfoSchema.nullish(),
    group: z.string().nullish(),
    recordingConfig: z
      .enum(["record", "do_not_record", "not_applicable", "unknown"])
      .nullish(),
    joinTime: isoDateTime.nullish(),
    leaveTime: isoDateTime.nullish(),
    slotNumber: z.string().nullish(),
    handsetInfo: z.string().nullish(),
  })
  .passthrough();

export const callEventSchema = z
  .object({
    eventTime: isoDateTime,
    eventType: z.enum([
      "ringing",
      "connected",
      "disconnected",
      "missed",
      "hold",
      "resume",
      "transfer_initiated",
      "transfer_completed",
      "transfer_failed",
      "conference_created",
      "participant_join",
      "participant_leave",
      "participant_rejoin",
      "barge_in",
      "monitor_start",
      "monitor_stop",
      "swap_audio_device",
      "record_on_demand_start",
      "record_on_demand_stop",
      "pause_recording",
      "resume_recording",
      "voicemail",
      "park",
      "ivr_entry",
      "ivr_exit",
      "queue_entry",
      "queue_exit",
      "pre_agent_event",
      "function_key_press",
      "other",
    ]),
    participantId: z.string().nullish(),
    targetParticipantId: z.string().nullish(),
    detail: z.string().nullish(),
    metadata: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export const callSourceSchema = z
  .object({
    huntNumber: z.string().nullish(),
    ivrInfo: z.string().nullish(),
    queueInfo: z.string().nullish(),
    timeInIvrSeconds: z.number().nullish(),
    timeInQueueSeconds: z.number().nullish(),
  })
  .passthrough();

export const wrapUpInfoSchema = z
  .object({
    wrapUpCode: z.string().nullish(),
    wrapUpNotes: z.string().nullish(),
    wrapUpDurationSeconds: z.number().nullish(),
  })
  .passthrough();

export const cloudRecordingSchema = z
  .object({
    recordingStatus: z
      .enum(["recorded", "not_recorded", "partial", "unknown"])
      .nullish(),
    recordingMethod: z
      .enum(["automatic", "manual", "on_demand", "unknown"])
      .nullish(),
    recordingId: z.string().nullish(),
    mediaName: z.string().nullish(),
    downloadPath: z.string().nullish(),
  })
  .passthrough();

export const qosSchema = z
  .object({
    mosScore: z.number().min(1).max(5).nullish(),
    latencyMs: z.number().nullish(),
    jitterMs: z.number().nullish(),
    packetLossPercent: z.number().min(0).max(100).nullish(),
    packetsTotal: z.number().int().nullish(),
  })
  .passthrough();

export const callRecordSchema = z
  .object({
    // Identity
    callId: z.string().min(1),
    parentCallId: z.string().nullish(),
    relatedCallIds: z.array(z.string()).nullish(),
    tenantId: z.string().nullish(),
    sourcePlatformId: z.string().nullish(),
    sourcePlatformType: z.string().nullish(),

    // Timing
    interactionStartTime: isoDateTime.nullish(),
    callStartTime: isoDateTime,
    callEndTime: isoDateTime.nullish(), // see spec note above
    interactionEndTime: isoDateTime.nullish(),
    lastUpdateTime: isoDateTime.nullish(),
    durationSeconds: z.number().nullish(),

    // State & type
    callState: z.enum(["ongoing", "ended", "missed", "abandoned"]),
    callDirection: z
      .enum(["inbound", "outbound", "internal", "unknown"])
      .nullish(),
    callType: z
      .enum([
        "peer_to_peer",
        "group",
        "conference",
        "meeting",
        "intercom",
        "private_wire",
        "voicemail",
        "unknown",
      ])
      .nullish(),
    mediaType: z.enum([
      "voice",
      "video",
      "chat",
      "instant_message",
      "email",
      "unknown",
    ]),

    // Routing
    callSource: callSourceSchema.nullish(),
    wrapUpInfo: wrapUpInfoSchema.nullish(),

    // Participants
    participants: z.array(participantSchema).min(1),

    // Timeline
    events: z.array(callEventSchema).nullish(),

    // Recording & QoS
    cloudRecording: cloudRecordingSchema.nullish(),
    qos: qosSchema.nullish(),

    // Extensibility
    vendorSpecificFields: z.record(z.unknown()).nullish(),

    // The example file tags each record with a human-readable scenario label.
    // Not part of the standard; accepted and preserved but ignored by the store.
    _scenario: z.string().nullish(),
  })
  .passthrough();

export type CallRecordInput = z.infer<typeof callRecordSchema>;

/** Ingest accepts either a single record or a batch. */
export const ingestBodySchema = z.union([
  callRecordSchema,
  z.array(callRecordSchema).min(1).max(1000),
]);
