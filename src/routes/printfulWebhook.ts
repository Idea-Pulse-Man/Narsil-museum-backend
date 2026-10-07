/**
 * Printful status webhook — keeps `canvas_orders` in sync after fulfillment
 * is handed off, so the app can show real tracking:
 *
 *   package_shipped → status 'shipped' + carrier tracking number/url
 *   order_canceled  → status 'cancelled'
 *   order_failed    → status 'fulfillment_failed' (+ reason)
 *
 * Printful doesn't sign webhook payloads or send custom headers, so the
 * endpoint is guarded by a shared secret in the URL. Configure it in the
 * Printful dashboard (Settings → Webhooks) or via their API as:
 *   https://<backend>/api/printful/webhook?secret=<PRINTFUL_WEBHOOK_SECRET>
 * with the three event types above enabled. Orders are matched by the
 * `external_id` we set at creation — our canvas_orders id.
 *
 * A URL secret can leak into access logs, so it is only the first gate: the
 * payload is treated as a hint, and every status change is confirmed against
 * Printful's API (authenticated with our key) before anything is written.
 * Forged events can at worst trigger a re-read of the true state.
 */
import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../services/supabaseAdmin.js";
import { getPrintfulOrder } from "../services/printful.js";
import { notifyUsers } from "../services/push.js";

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

const HANDLED_EVENTS = new Set([
  "package_shipped",
  "order_canceled",
  "order_failed",
]);

/** Constant-time check of the shared secret (URL query, or a header). */
function secretMatches(req: Request, expected: string): boolean {
  const header = req.get("x-webhook-secret");
  const provided =
    header ?? (typeof req.query.secret === "string" ? req.query.secret : "");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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
      if (!secretMatches(req, env.printful.webhookSecret)) {
        res.status(401).json({ error: "Unauthorized", message: "Bad secret." });
        return;
      }

      const event = (req.body ?? {}) as PrintfulEvent;
      const orderId = event.data?.order?.external_id;
      if (!orderId || !HANDLED_EVENTS.has(event.type ?? "")) {
        // Not one of our checkout orders (e.g. created by hand in Printful),
        // or an event type we don't act on.
        res.json({ received: true });
        return;
      }

      // Confirm against Printful before writing anything.
      const order = await getPrintfulOrder(orderId);
      if (!order) {
        console.warn(`[printful] webhook for unknown order ${orderId} ignored`);
        res.json({ received: true });
        return;
      }

      let update: Record<string, unknown> | null = null;
      switch (event.type) {
        case "package_shipped": {
          const shipment = order.shipments[order.shipments.length - 1];
          if (!shipment) break;
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
          if (order.status === "canceled") update = { status: "cancelled" };
          break;
        case "order_failed":
          if (order.status === "failed") {
            update = {
              status: "fulfillment_failed",
              fulfillment_error:
                event.data?.reason ?? "Printful reported a failure",
            };
          }
          break;
      }

      if (!update) {
        console.warn(
          `[printful] ${event.type} for order ${orderId} doesn't match ` +
            `Printful's state (${order.status}); ignored`,
        );
      }

      if (update) {
        const { data: updated, error } = await supabaseAdmin()
          .from("canvas_orders")
          .update(update)
          .eq("id", orderId)
          .select("user_id, status")
          .maybeSingle();
        if (error) {
          console.error(
            `[printful] webhook update for order ${orderId} failed: ${error.message}`,
          );
        } else {
          console.log(`[printful] order ${orderId}: ${event.type}`);
          const buyer = (updated as { user_id?: string | null } | null)?.user_id;
          if (buyer && event.type === "package_shipped") {
            void notifyUsers([buyer], {
              title: "Your print has shipped",
              body: "It's on its way — tap to see tracking.",
              data: { type: "orders" },
            });
          }
        }
      }

      res.json({ received: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
