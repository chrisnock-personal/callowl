import fs from "fs";
import { config } from "../config";
import { logger } from "../logger";
import { query } from "./pool";
import { callRecordSchema } from "../schemas/cdr";
import { ingestRecords } from "../services/ingestService";

/**
 * Seed the five example scenarios shipped with the Open CDR Standard
 * (cdr-examples.json) so a fresh install has representative data to explore.
 * Idempotent: skips if the store already holds records. Each example is
 * validated against the schema first — the seed doubles as a conformance check
 * on the standard's own examples.
 */
export async function seedExamples(): Promise<void> {
  const existing = await query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM call_records"
  );
  if (parseInt(existing[0]?.n ?? "0", 10) > 0) {
    logger.info("Seed skipped — call_records already populated");
    return;
  }

  const raw = fs.readFileSync(config.paths.examplesJson, "utf-8");
  const parsed = JSON.parse(raw) as { examples: unknown[] };
  const records = parsed.examples.map((e) => callRecordSchema.parse(e));

  const results = await ingestRecords(records);
  logger.info("Seeded example CDRs from the standard", { count: results.length });
}

// Standalone runner (npm run seed)
if (require.main === module) {
  seedExamples()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("Seed failed", { err });
      process.exit(1);
    });
}
