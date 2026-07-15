import { seedDemoData } from "./seedDemo";
import { logger } from "../logger";

/**
 * Same generator as seedDemo.ts (npm run seed:demo) — every scenario, every
 * field it touches — just spread over the last 12 months instead of 6, and
 * tagged with a distinct callId prefix (`demo12mo-` instead of `demo5k-`) so
 * the two batches stay independently identifiable and clearable. Still 5,000
 * records, so per-month density is roughly half of the 6-month generator's;
 * this is for demoing a full year of history (e.g. wider Range presets, or
 * throughput/seasonality trends), not for more volume.
 */
const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

// Standalone runner (npm run seed:demo:12mo)
if (require.main === module) {
  seedDemoData({ windowMs: TWELVE_MONTHS_MS, idPrefix: "demo12mo" })
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("12-month rich demo seed failed", { err });
      process.exit(1);
    });
}
