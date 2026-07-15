import { Router, Request, Response } from "express";
import { register } from "../metrics";

const router = Router();

// GET /metrics — Prometheus text-exposition format. Unauthenticated,
// matching /health's existing precedent: meant to be scraped by internal
// infra (not a person), and reveals only counts/timings, not record content.
router.get("/", async (_req: Request, res: Response) => {
  res.set("Content-Type", register.contentType);
  res.send(await register.metrics());
});

export default router;
