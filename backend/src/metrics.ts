import client from "prom-client";

// prom-client rather than hand-rolled: Prometheus's text-exposition format
// has real spec details (histogram bucket/_sum/_count naming, content-type)
// worth getting from a well-established library — same reasoning that led
// to otplib for TOTP rather than hand-rolling RFC 6238.

export const register = new client.Registry();
client.collectDefaultMetrics({ register }); // process CPU/memory/event-loop-lag

// One histogram covers both latency and error rate — _count/_bucket per
// status_code label combination already gives request counts and 5xx rate
// via a PromQL rate() query, no separate counter needed.
export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

export const remotePollOutcomes = new client.Counter({
  name: "remote_poll_outcomes_total",
  help: "Remote source poll attempts by outcome",
  labelNames: ["status"], // ok | auth_error | fetch_error | validation_rejects | skipped_locked
  registers: [register],
});
