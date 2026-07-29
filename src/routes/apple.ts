/**
 * Apple subscription routes.
 *
 *   POST /api/apple/verify         — signed-in. The app hands over the signed
 *     transaction it got from StoreKit (after a purchase OR a restore); we
 *     verify it, ask Apple for the current status, and bind the entitlement to
 *     this Supabase user.
 *   POST /api/apple/notifications  — called by Apple, not by the app. App Store
 *     Server Notifications V2: renewals, cancellations, refunds, billing
 *     failures. This is what makes an entitlement actually END.
 *
 * Register the notifications URL in App Store Connect for BOTH the Production
 * and Sandbox environments, or TestFlight lifecycle events never arrive.
 */
import { Router } from "express";
import { authedUser, requireUser } from "../middleware/auth.js";
import {
  appleConfigured,
  resolveEntitlement,
  verifyNotification,
  verifyTransaction,
} from "../services/appleStore.js";
import {
  getSubscription,
  updateSubscriptionByTransaction,
  upsertSubscription,
} from "../services/subscriptions.js";

export function appleRoutes(): Router {
  const router = Router();

  router.post("/verify", requireUser, async (req, res, next) => {
    try {
      if (!appleConfigured()) {
        res.status(503).json({
          error: "Service Unavailable",
          message: "Subscriptions are not configured.",
        });
        return;
      }

      const { signedTransaction } = (req.body ?? {}) as {
        signedTransaction?: string;
      };
      if (!signedTransaction) {
        res.status(400).json({
          error: "Bad Request",
          message: "signedTransaction is required.",
        });
        return;
      }

      const user = authedUser(req);
      const { originalTransactionId } =
        await verifyTransaction(signedTransaction);

      // The signed transaction proves a purchase happened; Apple's status API
      // says whether it is still live. Always write the latter.
      const snapshot = await resolveEntitlement(originalTransactionId);
      if (!snapshot) {
        res.status(409).json({
          error: "Conflict",
          message: "Apple has no current status for this subscription.",
        });
        return;
      }

      await upsertSubscription({
        userId: user.id,
        originalTransactionId: snapshot.originalTransactionId,
        productId: snapshot.productId,
        status: snapshot.status,
        expiresAtMs: snapshot.expiresAtMs,
        autoRenew: snapshot.autoRenew,
        environment: snapshot.environment,
      });

      console.log(
        `[apple] ${user.id} → ${snapshot.productId} (${snapshot.status})`,
      );
      res.json(await getSubscription(user.id));
    } catch (err) {
      next(err);
    }
  });

  router.post("/notifications", async (req, res) => {
    // Apple retries any non-2xx, so the only responses that should escape here
    // are 200 (handled) and 500 (please retry).
    if (!appleConfigured()) {
      res.status(503).json({ error: "Service Unavailable" });
      return;
    }

    const { signedPayload } = (req.body ?? {}) as { signedPayload?: string };
    if (!signedPayload) {
      res.status(400).json({ error: "Bad Request" });
      return;
    }

    try {
      const notification = await verifyNotification(signedPayload);
      const { notificationType, subtype, originalTransactionId } = notification;

      if (!originalTransactionId) {
        // Notifications that carry no transaction (e.g. TEST) — acknowledge.
        console.log(`[apple] notification ${notificationType} (no transaction)`);
        res.status(200).json({ received: true });
        return;
      }

      // Re-read the authoritative status rather than hand-mapping each of
      // Apple's ~15 notification types onto a status and getting one wrong.
      const snapshot = await resolveEntitlement(originalTransactionId);
      if (!snapshot) {
        console.warn(
          `[apple] ${notificationType}: Apple returned no status for ` +
            `${originalTransactionId}`,
        );
        res.status(200).json({ received: true });
        return;
      }

      const known = await updateSubscriptionByTransaction(
        originalTransactionId,
        {
          status: snapshot.status,
          expiresAtMs: snapshot.expiresAtMs,
          autoRenew: snapshot.autoRenew,
          productId: snapshot.productId,
        },
      );

      if (!known) {
        // The purchase hasn't been bound to a Supabase user yet (the app's
        // verify call lost a race, or never ran). Nothing to update — the
        // verify call writes the current status when it arrives, so no state
        // is lost. Acknowledge so Apple stops retrying.
        console.warn(
          `[apple] ${notificationType}: no local row for ${originalTransactionId}`,
        );
      } else {
        console.log(
          `[apple] ${notificationType}${subtype ? `/${subtype}` : ""} → ` +
            `${snapshot.status} (${originalTransactionId})`,
        );
      }

      res.status(200).json({ received: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[apple] notification failed: ${message}`);
      // 500 so Apple redelivers — a dropped REFUND or EXPIRED would otherwise
      // leave someone entitled forever.
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  return router;
}
