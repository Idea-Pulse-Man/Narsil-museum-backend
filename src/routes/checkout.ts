/**
 * Canvas checkout routes (all require a signed-in Supabase user).
 *
 *   POST /api/checkout/payment-intent        — price the order server-side,
 *     create the pending canvas_orders row + Stripe PaymentIntent, return the
 *     client secret the app pays with.
 *   POST /api/checkout/orders/:id/finalize   — after Stripe.js reports success,
 *     verify the payment and submit the Printful order. Idempotent — the
 *     Stripe webhook does the same thing, whichever runs first wins.
 *   GET  /api/checkout/orders/:id            — fulfillment status polling.
 */
import { Router } from "express";
import type { CatalogService } from "../museum/catalog.js";
import { authedUser, requireUserFor } from "../middleware/auth.js";
import {
  createCheckout,
  finalizeOrder,
  getOrderStatus,
} from "../services/checkout.js";

export function checkoutRoutes(catalog: CatalogService): Router {
  const router = Router();
  router.use(requireUserFor("Sign in to order a canvas."));

  router.post("/payment-intent", async (req, res, next) => {
    try {
      const { artworkId, size, addressId } = (req.body ?? {}) as {
        artworkId?: string;
        size?: string;
        addressId?: string;
      };
      if (!artworkId || !size || !addressId) {
        res.status(400).json({
          error: "Bad Request",
          message: "artworkId, size and addressId are required.",
        });
        return;
      }
      const intent = await createCheckout(catalog, authedUser(req), {
        artworkId,
        size,
        addressId,
      });
      res.json(intent);
    } catch (err) {
      next(err);
    }
  });

  router.post("/orders/:id/finalize", async (req, res, next) => {
    try {
      const status = await finalizeOrder(
        catalog,
        req.params.id,
        authedUser(req).id,
      );
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  router.get("/orders/:id", async (req, res, next) => {
    try {
      res.json(await getOrderStatus(req.params.id, authedUser(req).id));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
