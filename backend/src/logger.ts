// Structured (JSON) logging — hand-rolled rather than pulling in pino/winston.
// The actual need here is modest: consistent {level, time, msg, ...fields}
// lines to stdout so `podman logs` output is machine-parseable, no log
// rotation, no multi-destination shipping, no runtime-configurable levels.
// A library's real advantage (pino's serialization throughput, mainly)
// doesn't matter at this app's actual scale — see README's Status section.

type Level = "info" | "warn" | "error";

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  (level === "error" ? console.error : console.log)(line);
}

export const logger = {
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  // Pass Error instances as { err } — JSON.stringify silently serializes a
  // bare Error to "{}", dropping the message/stack, so this pulls both out
  // explicitly rather than trusting spread to do the right thing.
  error: (msg: string, fields?: Record<string, unknown> & { err?: unknown }) => {
    const { err, ...rest } = fields ?? {};
    const errField = err instanceof Error ? { message: err.message, stack: err.stack } : err;
    write("error", msg, err !== undefined ? { ...rest, err: errField } : rest);
  },
};
