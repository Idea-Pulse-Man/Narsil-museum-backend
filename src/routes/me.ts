/**
 * Current-user routes.
 *
 *   GET  /api/me/subscription — the app's own Narsil Pro state, for rendering
 *     the paywall and the "Pro" badge.
 *   POST /api/me/delete — permanently delete the account (services/
 *     accountDeletion.ts). POST rather than DELETE: CORS and CloudFront are
 *     configured for GET/POST only.
 *
 * This answer is for DISPLAY ONLY. Every paid perk re-checks entitlement
 * server-side (`services/subscriptions.ts` → `isSubscriber`), because a client
 * that has been told "you are Pro" is not evidence that it is.
 */
import { Router } from "express";
import { authedUser, requireUserFor } from "../middleware/auth.js";
import { getSubscription } from "../services/subscriptions.js";
import { deleteAccount } from "../services/accountDeletion.js";

export function meRoutes(): Router {
  const router = Router();
  router.use(requireUserFor("Sign in to manage your account."));

  router.get("/subscription", async (req, res, next) => {
    try {
      res.json(await getSubscription(authedUser(req).id));
    } catch (err) {
      next(err);
    }
  });

  router.post("/delete", async (req, res, next) => {
    try {
      await deleteAccount(authedUser(req).id);
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
