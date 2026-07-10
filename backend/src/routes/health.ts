import { Router, Request, Response } from "express";
import { query } from "../db/pool";
import { config } from "../config";
import type { HealthResponse } from "../types";

const router = Router();

// GET /health  → components.schemas.HealthResponse
router.get("/", async (_req: Request, res: Response) => {
  const base = {
    apiVersion: config.apiVersion,
    platformVersion: config.platformVersion,
    timestamp: new Date().toISOString(),
  };
  try {
    await query("SELECT 1");
    const body: HealthResponse = { status: "healthy", ...base };
    res.json(body);
  } catch {
    const body: HealthResponse = { status: "unavailable", ...base };
    res.status(503).json(body);
  }
});

export default router;
