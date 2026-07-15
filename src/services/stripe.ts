/**
 * Lazily-initialised Stripe client. Kept behind a getter so the server boots
 * fine without a key — checkout routes then answer 503 instead of crashing
 * catalog-only deployments.
 */
import Stripe from "stripe";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

let stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!env.stripe.secretKey) {
    throw new HttpError(503, "Stripe is not configured (STRIPE_SECRET_KEY).");
  }
  if (!stripe) {
    stripe = new Stripe(env.stripe.secretKey);
  }
  return stripe;
}
