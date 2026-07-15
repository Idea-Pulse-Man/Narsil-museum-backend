/**
 * Printful status webhook — keeps `canvas_orders` in sync after fulfillment
 * is handed off, so the app can show real tracking:
 *
 *   package_shipped → status 'shipped' + carrier tracking number/url
 *   order_canceled  → status 'cancelled'
 *   order_failed    → status 'fulfillment_failed' (+ reason)
 *
 * Printful doesn't sign webhook payloads, so the endpoint is guarded by a
 * shared secret in the URL. Configure it in the Printful dashboard
 * (Settings → Webhooks) or via their API as:
 *   https://<backend>/api/printful/webhook?secret=<PRINTFUL_WEBHOOK_SECRET>
 * with the three event types above enabled. Orders are matched by the
 * `external_id` we set at creation — our canvas_orders id.
 */
import { Router } from "express";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../services/supabaseAdmin.js";

interface PrintfulEvent {
  type?: string;
  data?: {
    reason?: string;
    order?: { id?: number; external_id?: string | null };
    shipment?: {
      carrier?: string;
      tracking_number?: string;
      tracking_url?: string;
      ship_date?: string;
    };
  };
}

export function printfulWebhookRoutes(): Router {
  const router = Router();

  router.post("/webhook", async (req, res, next) => {
    try {
      if (!env.printful.webhookSecret) {
        res.status(503).json({
          error: "Not Configured",
          message: "PRINTFUL_WEBHOOK_SECRET is not set.",
        });
        return;
      }
      if (req.query.secret !== env.printful.webhookSecret) {
        res.status(401).json({ error: "Unauthorized", message: "Bad secret." });
        return;
      }

      const event = (req.body ?? {}) as PrintfulEvent;
      const orderId = event.data?.order?.external_id;
      if (!orderId) {
        // Not one of our checkout orders (e.g. created by hand in Printful).
        res.json({ received: true });
        return;
      }

      let update: Record<string, unknown> | null = null;
      switch (event.type) {
        case "package_shipped": {
          const shipment = event.data?.shipment ?? {};
          update = {
            status: "shipped",
            tracking_number: shipment.tracking_number ?? null,
            tracking_url: shipment.tracking_url ?? null,
            shipped_at: shipment.ship_date
              ? new Date(shipment.ship_date).toISOString()
              : new Date().toISOString(),
          };
          break;
        }
        case "order_canceled":
          update = { status: "cancelled" };
          break;
        case "order_failed":
          update = {
            status: "fulfillment_failed",
            fulfillment_error: event.data?.reason ?? "Printful reported a failure",
          };
          break;
        default:
          break; // ignore other event types
      }

      if (update) {
        const { error } = await supabaseAdmin()
          .from("canvas_orders")
          .update(update)
          .eq("id", orderId);
        if (error) {
          console.error(
            `[printful] webhook update for order ${orderId} failed: ${error.message}`,
          );
        } else {
          console.log(`[printful] order ${orderId}: ${event.type}`);
        }
      }

      res.json({ received: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
