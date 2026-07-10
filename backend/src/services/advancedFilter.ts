import { createError } from "../middleware/errorHandler";

/**
 * Advanced filter expressions (GET /calls?advanced=...) — a small grammar for
 * numeric conditions the fixed dropdown/text filters can't express, e.g.
 * "mos < 3, jitter > 50". Comma-separated clauses are ANDed together.
 *
 * Field names are an allowlist mapping to a fixed SQL column expression —
 * user input only ever supplies the field *name* (validated against this map)
 * and a numeric value (validated against a strict regex), never SQL itself,
 * so there's no injection surface despite building raw fragments below.
 */
const FIELD_COLUMNS: Record<string, string> = {
  mos: `(record->'qos'->>'mosScore')::numeric`,
  jitter: `(record->'qos'->>'jitterMs')::numeric`,
  latency: `(record->'qos'->>'latencyMs')::numeric`,
  packetLoss: `(record->'qos'->>'packetLossPercent')::numeric`,
  duration: `duration_seconds`,
  ivrTime: `(record->'callSource'->>'timeInIvrSeconds')::numeric`,
  queueTime: `(record->'callSource'->>'timeInQueueSeconds')::numeric`,
};

export const ADVANCED_FILTER_FIELDS = Object.keys(FIELD_COLUMNS);

// Longest-first so "<=" isn't ever matched as "<" followed by a stray "=".
const CLAUSE_RE = /^([a-zA-Z]+)\s*(<=|>=|!=|<|>|=)\s*(-?\d+(?:\.\d+)?)$/;

export interface ParsedClause {
  column: string;
  operator: string;
  value: number;
}

/**
 * Parses "field op value, field op value, ..." into clauses ready to become
 * parameterized SQL. Throws a 400 ApiError (safe to surface to the caller —
 * it's just field-name/syntax feedback) on anything malformed or unknown.
 */
export function parseAdvancedFilter(expr: string): ParsedClause[] {
  return expr
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((clause) => {
      const m = CLAUSE_RE.exec(clause);
      if (!m) {
        throw createError(
          `Invalid advanced filter clause "${clause}" — expected "field operator value", e.g. "mos < 3"`,
          400
        );
      }
      const [, field, operator, valueStr] = m;
      const column = FIELD_COLUMNS[field];
      if (!column) {
        throw createError(
          `Unknown advanced filter field "${field}" — supported fields: ${ADVANCED_FILTER_FIELDS.join(", ")}`,
          400
        );
      }
      return { column, operator, value: parseFloat(valueStr) };
    });
}
