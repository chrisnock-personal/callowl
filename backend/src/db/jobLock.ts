import { query } from "./pool";

/**
 * Atomically claims jobName for leaseMs from now, unless someone else already
 * holds an unexpired claim on it. Single round-trip, no held connection —
 * safe for a job whose actual duration may exceed a normal request/response
 * cycle (see scheduled_job_locks migration for why this isn't an advisory
 * lock instead). Call once per actual job execution, not once per caller —
 * callers within the same process that just want to piggyback on an
 * already-running job (e.g. two near-simultaneous poll requests) should keep
 * using an in-process guard (see remotePollService.ts's inFlightPolls) rather
 * than each hitting this.
 */
export async function tryClaimJob(jobName: string, leaseMs: number): Promise<boolean> {
  const rows = await query<{ job_name: string }>(
    `INSERT INTO scheduled_job_locks (job_name, locked_until)
     VALUES ($1, now() + ($2::numeric * interval '1 millisecond'))
     ON CONFLICT (job_name) DO UPDATE
       SET locked_until = EXCLUDED.locked_until
       WHERE scheduled_job_locks.locked_until < now()
     RETURNING job_name`,
    [jobName, leaseMs]
  );
  return rows.length > 0;
}
