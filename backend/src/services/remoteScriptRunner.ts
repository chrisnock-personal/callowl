import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { RemoteSourceAuth, RemoteSourceInternal } from "./remoteSourceService";

type CustomAuth = Extract<RemoteSourceAuth, { authType: "custom" }>;

export interface ScriptRunResult {
  records: unknown[];
  watermark: string | null;
}

// Deliberately generous — CPython + ssl/socket import overhead alone can
// consume more *virtual* address space than intuition suggests, so a tight
// ulimit -v causes false-positive failures at import time before any user
// code runs. This is coarse protection against a runaway allocation loop,
// not a precise per-script memory budget.
const SCRIPT_MEMORY_LIMIT_KB = 524_288; // ~512MB virtual
// One-shot connect+list+parse work with no pagination to spread it across —
// roughly 4x the HTTP path's per-page 30s timeout (remotePollService.ts).
const SCRIPT_TIMEOUT_MS = 120_000;
// A SIGTERM isn't guaranteed to actually kill the process (realistic if the
// script, or a C extension it's blocked in, ignores it or is stuck in an
// uninterruptible syscall) — escalate to SIGKILL if it's still alive this
// long after.
const SCRIPT_KILL_GRACE_MS = 5_000;
// Bounds what THIS (parent) Node process buffers from the child's stdout —
// independent of SCRIPT_MEMORY_LIMIT_KB, which only bounds the Python
// child's own virtual memory, not what gets read from the pipe here. A
// runaway/malicious script printing gigabytes before exiting would otherwise
// pressure the backend's own process, not just itself.
const SCRIPT_STDOUT_MAX_BYTES = 10_000_000;

interface RawScriptOutput {
  records?: unknown;
  watermark?: unknown;
}

/**
 * Executes an admin-authored Python script that owns its entire pull: connect
 * to whatever the remote actually is, find what's new since the watermark,
 * parse and map it into CallRecord shape, print { records, watermark } to
 * stdout, exit 0. Runs in-container as the backend's own non-root `node`
 * user (no Docker-in-Docker, no per-run container) with a wall-clock
 * timeout, a memory ceiling, and a stdout size cap — coarse defense-in-depth
 * appropriate for a trusted-admin-authored-script feature, not a sandbox
 * against a hostile script author (no import/dependency allowlisting, no
 * filesystem restriction beyond the per-run temp cwd, network deliberately
 * unrestricted since scripts need real connectivity to reach their source).
 */
export async function runCustomScript(
  source: RemoteSourceInternal & { auth: CustomAuth }
): Promise<ScriptRunResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-script-"));
  const scriptPath = path.join(tmpDir, "script.py");
  fs.writeFileSync(scriptPath, source.auth.scriptBody, "utf8");

  try {
    const { stdout } = await execScript(scriptPath, tmpDir, {
      // Not a full ...process.env spread (would leak PGPASSWORD/
      // REMOTE_SOURCE_ENC_KEY/other backend secrets into admin-authored
      // script code) and not empty either (breaks real scripts — no PATH
      // means a script's own subprocess calls can't resolve binaries; no
      // LANG/LC_ALL risks a UnicodeEncodeError the moment a script prints
      // non-ASCII JSON, e.g. an accented caller name, under a minimal-locale
      // default) — a deliberate minimal allowlist plus the admin's own vars.
      PATH: process.env.PATH ?? "",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      ...source.auth.env,
      WATERMARK: source.watermark ?? source.backfillFrom,
    });

    let parsed: RawScriptOutput;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("Script stdout was not valid JSON");
    }
    if (!Array.isArray(parsed.records)) {
      throw new Error('Script stdout did not have a "records" array');
    }
    const watermark = typeof parsed.watermark === "string" ? parsed.watermark : null;
    return { records: parsed.records, watermark };
  } finally {
    // force: true — a killed process may leave partial artifacts (whatever
    // it wrote into cwd) that shouldn't make cleanup itself throw and mask
    // the real error from above.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function execScript(scriptPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "sh",
      ["-c", `ulimit -v ${SCRIPT_MEMORY_LIMIT_KB}; exec python3 "$0"`, scriptPath],
      { cwd, env }
    );

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let exited = false;
    let timedOut = false;
    let tooLarge = false;

    // subprocess.killed only reflects "a signal was successfully sent," not
    // "the process has actually exited" — track exit via the close event
    // instead, so the grace-period SIGKILL only fires if SIGTERM didn't work.
    const killWithGrace = () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) proc.kill("SIGKILL");
      }, SCRIPT_KILL_GRACE_MS);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killWithGrace();
    }, SCRIPT_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > SCRIPT_STDOUT_MAX_BYTES) {
        if (!tooLarge) {
          tooLarge = true;
          killWithGrace();
        }
        return;
      }
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutTimer);
      reject(new Error(`Failed to start script: ${err.message}`));
    });

    proc.on("close", (code, signal) => {
      exited = true;
      clearTimeout(timeoutTimer);
      if (tooLarge) {
        reject(new Error(`Script stdout exceeded ${SCRIPT_STDOUT_MAX_BYTES} bytes — killed`));
        return;
      }
      if (timedOut) {
        reject(new Error(`Script timed out after ${SCRIPT_TIMEOUT_MS}ms — killed`));
        return;
      }
      if (signal) {
        reject(new Error(`Script terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Script exited ${code}: ${stderr.trim()}`.trim()));
        return;
      }
      resolve({ stdout });
    });
  });
}
