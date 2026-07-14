import { describe, it, expect } from "vitest";
import { callRecordSchema, ingestBodySchema } from "./cdr";
import cdrExamples from "../data/cdr-examples.json";

describe("callRecordSchema — vendored standard examples", () => {
  const examples = (cdrExamples as { examples: unknown[] }).examples;

  it("has at least one example to validate against", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(
    examples.map((e) => [(e as { _scenario?: string })._scenario ?? "(unlabeled)", e])
  )("%s parses as a conforming CallRecord", (_label, example) => {
    const result = callRecordSchema.safeParse(example);
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(
      true
    );
  });
});

function minimalValidRecord() {
  return {
    callId: "test-call-1",
    callStartTime: "2026-01-01T00:00:00.000Z",
    callState: "ended",
    mediaType: "voice",
    participants: [
      { participantId: "p1", role: "caller", extension: "1001" },
      { participantId: "p2", role: "callee", extension: "1002" },
    ],
  };
}

describe("callRecordSchema — rejection cases", () => {
  it("accepts the minimal valid record as a sanity baseline", () => {
    expect(callRecordSchema.safeParse(minimalValidRecord()).success).toBe(true);
  });

  it("rejects a record missing callId", () => {
    const record = minimalValidRecord() as Record<string, unknown>;
    delete record.callId;
    const result = callRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "callId")).toBe(
        true
      );
    }
  });

  it("rejects an out-of-vocabulary mediaType", () => {
    const record = { ...minimalValidRecord(), mediaType: "fax" };
    const result = callRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "mediaType")).toBe(
        true
      );
    }
  });

  it("rejects a non-ISO-8601 callStartTime", () => {
    const record = { ...minimalValidRecord(), callStartTime: "01/01/2026" };
    const result = callRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path.join(".") === "callStartTime")
      ).toBe(true);
    }
  });

  it("rejects zero participants", () => {
    const record = { ...minimalValidRecord(), participants: [] };
    const result = callRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path.join(".") === "participants")
      ).toBe(true);
    }
  });

  // .nullish() (not .optional()) is a deliberate divergence from a plain
  // optional field — the standard's own examples represent an absent
  // optional value as explicit JSON null, so the gate has to accept both.
  it("accepts explicit null on a nullish optional field (parentCallId)", () => {
    const record = { ...minimalValidRecord(), parentCallId: null };
    expect(callRecordSchema.safeParse(record).success).toBe(true);
  });

  it("accepts an omitted optional field just as well as an explicit null", () => {
    const record = minimalValidRecord() as Record<string, unknown>;
    expect(callRecordSchema.safeParse(record).success).toBe(true);
  });
});

describe("ingestBodySchema — single record or batch", () => {
  it("accepts a single record", () => {
    expect(ingestBodySchema.safeParse(minimalValidRecord()).success).toBe(true);
  });

  it("accepts a batch of records", () => {
    const batch = [minimalValidRecord(), { ...minimalValidRecord(), callId: "test-call-2" }];
    expect(ingestBodySchema.safeParse(batch).success).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(ingestBodySchema.safeParse([]).success).toBe(false);
  });

  it("rejects a batch containing one invalid record", () => {
    const batch = [minimalValidRecord(), { ...minimalValidRecord(), mediaType: "fax" }];
    expect(ingestBodySchema.safeParse(batch).success).toBe(false);
  });
});
