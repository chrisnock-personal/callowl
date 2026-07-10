import type { CallRecordInput } from "../schemas/cdr";

/** A stored CallRecord as returned by the API — the spec-compliant object. */
export type CallRecord = CallRecordInput;

/** components.schemas.Pagination */
export interface Pagination {
  page: number;
  pageSize: number;
  totalPages: number;
  totalRecords: number;
}

/** components.schemas.CallRecordPage */
export interface CallRecordPage {
  data: CallRecord[];
  pagination: Pagination;
}

/** components.schemas.StatisticsSummary */
export interface StatisticsSummary {
  periodStart: string;
  periodEnd: string;
  byComponent: ComponentStat[];
  byMediaType: MediaTypeStat[];
  voiceBreakdown: VoiceBreakdown;
  averageDurations: AverageDurations;
}

export interface ComponentStat {
  componentType:
    | "sbc"
    | "ivr"
    | "iva"
    | "switch"
    | "call_queue"
    | "acd"
    | "group"
    | "skill";
  componentId: string;
  totalInteractions: number;
}

export interface MediaTypeStat {
  mediaType: "voice" | "video" | "chat" | "instant_message" | "email";
  totalInteractions: number;
}

export interface VoiceBreakdown {
  maturedAnswered: number;
  unmaturedUnanswered: number;
  abandonedDuringIvr: number;
  abandonedDuringQueue: number;
}

export interface AverageDurations {
  avgTimeInIvrSeconds: number;
  avgTimeInQueueSeconds: number;
  avgTimeWithAgentSeconds: number;
  avgTotalInteractionSeconds: number;
}

/** components.schemas.HealthResponse */
export interface HealthResponse {
  status: "healthy" | "degraded" | "unavailable";
  apiVersion: string;
  platformVersion?: string;
  timestamp: string;
}
