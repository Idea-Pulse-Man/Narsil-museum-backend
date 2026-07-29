/**
 * Current-user routes.
 *
 *   GET /api/me/subscription — the app's own Narsil Pro state, for rendering
 *     the paywall, the "Pro" badge and the discount line.
 *
 * This answer is for DISPLAY ONLY. Every paid perk re-checks entitlement
 * server-side (`services/subscriptions.ts` → `isSubscriber`), because a client
 * that has been told "you are Pro" is not evidence that it is.
 */
import { Router } from "express";
import { authedUser, requireUser } from "../middleware/auth.js";
import { getSubscription } from "../services/subscriptions.js";

export function meRoutes(): Router {
  const router = Router();
  router.use(requireUser);

  router.get("/subscription", async (req, res, next) => {
    try {
      res.json(await getSubscription(authedUser(req).id));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
