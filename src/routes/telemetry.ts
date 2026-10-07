import { Router } from "express";
import { rateLimit } from "../middleware/rateLimit.js";
import { parseBatch, storeBatch } from "../services/telemetry.js";

/** One app batches every ~15 s; this leaves plenty of room for a busy session. */
const telemetryLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 120,
  message: "Too many telemetry batches.",
});

/**
 * POST /api/telemetry — anonymous usage events and app errors from the app
 * (museum-app/src/lib/telemetry.ts). Always answers 202 for a well-formed
 * batch, even if storing it fails: the app must never retry or block on this.
 */
export function telemetryRoutes(): Router {
  const router = Router();

  router.post("/", telemetryLimiter, (req, res) => {
    const batch = parseBatch(req.body);
    if (!batch) {
      res.status(400).json({ error: "Bad Request", message: "Not a telemetry batch." });
      return;
    }
    res.status(202).json({ accepted: batch.items.length });
    void storeBatch(batch).catch((err) => {
      console.warn(`[telemetry] store failed: ${err instanceof Error ? err.message : err}`);
    });
  });

  return router;
}
