/**
 * Admin-only routes (all guarded by `requireAdmin`).
 *
 *   POST /api/admin/orders/:id/retry — re-drive fulfilment for an order whose
 *     payment was captured but whose Printful submission failed or never ran.
 *     Same code path as the buyer's own finalize call, minus the owner check,
 *     so it stays idempotent against the Stripe webhook.
 *   GET  /api/admin/orders/:id       — fulfilment status for any order.
 *
 * Everything else the dashboard does (listing, flags, roles, suspensions) goes
 * straight to Supabase under RLS — only work needing server secrets (Stripe,
 * Printful) lives here.
 */
import { Router } from "express";
import type { CatalogService } from "../museum/catalog.js";
import { requireAdmin } from "../middleware/auth.js";
import { finalizeOrder, getOrderStatus } from "../services/checkout.js";

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

  return router;
}
