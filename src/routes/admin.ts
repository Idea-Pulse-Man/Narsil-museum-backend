/**
 * Admin-only routes (all guarded by `requireAdmin`).
 *
 *   POST /api/admin/orders/:id/retry — re-drive fulfilment for an order whose
 *     payment was captured but whose Printful submission failed or never ran.
 *     Same code path as the buyer's own finalize call, minus the owner check,
 *     so it stays idempotent against the Stripe webhook.
 *   GET  /api/admin/orders/:id       — fulfilment status for any order.
 *   POST /api/admin/quiz/generate    — OpenAI MCQs grounded in catalog works.
 *
 * Everything else the dashboard does (listing, flags, roles, suspensions) goes
 * straight to Supabase under RLS — only work needing server secrets (Stripe,
 * Printful, OpenAI) lives here.
 */
import { Router } from "express";
import type { CatalogService } from "../museum/catalog.js";
import { requireAdmin } from "../middleware/auth.js";
import { finalizeOrder, getOrderStatus } from "../services/checkout.js";
import { generateQuizQuestions } from "../services/quizGenerate.js";

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

  return router;
}
