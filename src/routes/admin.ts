/**
 * Admin-only routes (all guarded by `requireAdmin`).
 *
 *   POST /api/admin/orders/:id/retry — re-drive fulfilment for an order whose
 *     payment was captured but whose Printful submission failed or never ran.
 *     Same code path as the buyer's own finalize call, minus the owner check,
 *     so it stays idempotent against the Stripe webhook.
 *   GET  /api/admin/orders/:id       — fulfilment status for any order.
 *   POST /api/admin/quiz/generate    — OpenAI MCQs grounded in catalog works.
 *   GET  /api/admin/quiz/engine/styles  — question-style registry (settings forms).
 *   POST /api/admin/quiz/engine/preview — sample questions for a style, not saved.
 *   POST /api/admin/quiz/engine/run     — "Generate now" (all enabled or one style);
 *     answers 202 { runId } at once and generates in the background.
 *   POST /api/admin/quiz/engine/daily/rebuild — refill today's daily mix from the
 *     styles switched on now.
 *   GET  /api/admin/quiz/engine/runs    — generator run history.
 *   GET  /api/admin/printful/drafts  — Printful orders waiting to be confirmed
 *     (paid orders arrive as drafts while PRINTFUL_CONFIRM_ORDERS is off).
 *
 * Everything else the dashboard does (listing, flags, roles, suspensions) goes
 * straight to Supabase under RLS — only work needing server secrets (Stripe,
 * Printful, OpenAI) lives here.
 */
import { Router } from "express";
import type { CatalogService } from "../museum/catalog.js";
import { authedUser, requireAdmin } from "../middleware/auth.js";
import { finalizeOrder, getOrderStatus } from "../services/checkout.js";
import { generateQuizQuestions } from "../services/quizGenerate.js";
import { listPrintfulDrafts } from "../services/printful.js";
import { listRuns, previewStyle, rebuildDailyEdition, startGeneration } from "../quiz/generate.js";
import { describeStyles } from "../quiz/styles/index.js";
import type { StyleSettings } from "../quiz/types.js";

export function adminRoutes(catalog: CatalogService): Router {
  const router = Router();
  router.use(requireAdmin);

  router.post("/orders/:id/retry", async (req, res, next) => {
    try {
      // No userId — an admin acts on any buyer's order.
      res.json(await finalizeOrder(catalog, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.get("/printful/drafts", async (_req, res, next) => {
    try {
      const drafts = await listPrintfulDrafts();
      res.json({ count: drafts.length, drafts });
    } catch (err) {
      next(err);
    }
  });

  router.get("/orders/:id", async (req, res, next) => {
    try {
      res.json(await getOrderStatus(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.post("/quiz/generate", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const topicKind = body.topic_kind === "empire" ? "empire" : "age";
      const topicId = String(body.topic_id ?? "").trim();
      const topicTitle = String(body.topic_title ?? topicId).trim();
      const difficultyRaw = String(body.difficulty ?? "apprentice");
      const difficulty =
        difficultyRaw === "scholar" || difficultyRaw === "master"
          ? difficultyRaw
          : "apprentice";
      const count = Math.min(10, Math.max(1, Number(body.count) || 5));
      const mode = String(body.mode ?? "auto");

      if (!topicId) {
        res.status(400).json({
          error: "Bad Request",
          message: "topic_id is required.",
        });
        return;
      }

      const [artworks, artists] = await Promise.all([
        catalog.listArtworks(),
        catalog.listArtists(),
      ]);

      const questions = await generateQuizQuestions(
        {
          topicKind,
          topicId,
          topicTitle,
          difficulty,
          count,
          mode,
        },
        artworks,
        artists,
      );

      if (!questions.length) {
        res.status(502).json({
          error: "Bad Gateway",
          message: "AI returned no usable questions — try again.",
        });
        return;
      }

      res.json({ questions });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Generate failed.";
      if (
        message.includes("OPENAI_API_KEY") ||
        message.includes("Not enough catalog")
      ) {
        res.status(400).json({ error: "Bad Request", message });
        return;
      }
      next(err);
    }
  });

  // ── Question engine (quiz_styles / quiz_items) ─────────────────────────

  router.get("/quiz/engine/styles", (_req, res) => {
    res.json({ styles: describeStyles() });
  });

  router.post("/quiz/engine/preview", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const style = String(body.style ?? "");
      const settings =
        body.settings && typeof body.settings === "object"
          ? (body.settings as StyleSettings)
          : null;
      const result = await previewStyle(style, settings, Number(body.count) || 3);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/quiz/engine/run", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const style = typeof body.style === "string" && body.style ? body.style : null;
      const count = Number(body.count);
      // Answers at once; the run continues in the background (CloudFront cuts
      // requests at 30 s). The admin panel polls GET /runs for the result.
      const { runId } = await startGeneration({
        trigger: "admin",
        styleIds: style ? [style] : undefined,
        count: Number.isFinite(count) && count > 0 ? Math.min(200, count) : undefined,
        fillDaily: body.fill_daily !== false,
        requestedBy: authedUser(req).id,
      });
      res.status(202).json({ runId, status: "running" });
    } catch (err) {
      next(err);
    }
  });

  router.post("/quiz/engine/daily/rebuild", async (_req, res, next) => {
    try {
      res.json(await rebuildDailyEdition());
    } catch (err) {
      next(err);
    }
  });

  router.get("/quiz/engine/runs", async (req, res, next) => {
    try {
      res.json({ runs: await listRuns(Number(req.query.limit) || 20) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
