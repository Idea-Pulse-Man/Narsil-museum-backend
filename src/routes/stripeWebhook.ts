/**
 * Stripe webhook — the authoritative "payment succeeded" signal. Mounted in
 * app.ts with `express.raw()` BEFORE the JSON body parser, because signature
 * verification needs the exact request bytes.
 *
 * On `payment_intent.succeeded` it runs the same idempotent finalize step the
 * app calls, so orders complete even if the customer closes the app right
 * after paying.
 */
import type { Request, RequestHandler, Response } from "express";
import type Stripe from "stripe";
import { env } from "../config/env.js";
import type { CatalogService } from "../museum/catalog.js";
import { finalizeOrder } from "../services/checkout.js";
import { getStripe } from "../services/stripe.js";

export function stripeWebhookHandler(catalog: CatalogService): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!env.stripe.webhookSecret) {
      res.status(503).json({
        error: "Not Configured",
        message: "STRIPE_WEBHOOK_SECRET is not set.",
      });
      return;
    }

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"] as string,
        env.stripe.webhookSecret,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid payload";
      console.warn(`[stripe] webhook signature rejected: ${message}`);
      res.status(400).json({ error: "Bad Request", message });
      return;
    }

    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;
      const orderId = intent.metadata?.order_id;
      if (orderId) {
        try {
          await finalizeOrder(catalog, orderId);
        } catch (err) {
          // Acknowledge anyway: the failure is recorded on the order
          // (fulfillment_failed) and the app's finalize call retries it —
          // a 5xx here would just make Stripe hammer the endpoint.
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[stripe] finalize for order ${orderId} failed: ${message}`);
        }
      }
    }

    res.json({ received: true });
  };
}
