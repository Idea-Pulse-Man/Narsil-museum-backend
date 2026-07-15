/**
 * Canvas checkout — the payment → fulfillment pipeline.
 * ---------------------------------------------------------------------------
 *  1. createCheckout: validates artwork + delivery address, computes the price
 *     SERVER-side, inserts a `canvas_orders` row (status `pending_payment`)
 *     and returns a Stripe PaymentIntent client secret for the app to pay.
 *  2. finalizeOrder: after Stripe reports success (webhook and/or the app's
 *     finalize call — both run it, it's idempotent), verifies the
 *     PaymentIntent, claims the order, and creates the Printful order.
 *
 * Order lifecycle: pending_payment → paid → submitted (Printful accepted)
 *                                        ↘ fulfillment_failed (retryable)
 */
import type Stripe from "stripe";
import { env } from "../config/env.js";
import type { CatalogService } from "../museum/catalog.js";
import { getArtworkFromSupabase } from "../museum/supabaseArtwork.js";
import { fullResImageUrl } from "../utils/imageDownload.js";
import { HttpError } from "../utils/httpError.js";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { getStripe } from "./stripe.js";
import { isCanvasSize, priceForSize, type CanvasSize } from "./pricing.js";
import { buildRecipient, type AddressRow } from "./recipient.js";
import { createPrintfulOrder, resolveVariantId } from "./printful.js";

export interface AuthedUser {
  id: string;
  email?: string;
}

export interface CheckoutInput {
  artworkId: string;
  size: string;
  addressId: string;
}

export interface CheckoutIntent {
  orderId: string;
  clientSecret: string;
  amount: number;
  currency: string;
  price: number;
}

interface OrderRow {
  id: string;
  user_id: string;
  artwork_id: string;
  size: string;
  price: number;
  status: string;
  address_id: string | null;
  stripe_payment_intent_id: string | null;
  printful_order_id: string | null;
}

const ORDER_COLUMNS =
  "id, user_id, artwork_id, size, price, status, address_id, stripe_payment_intent_id, printful_order_id";

const ADDRESS_COLUMNS =
  "id, label, recipient_name, phone, line1, line2, city, region, postal_code, country";

async function loadAddress(
  addressId: string,
  userId: string,
): Promise<AddressRow> {
  const { data, error } = await supabaseAdmin()
    .from("addresses")
    .select(ADDRESS_COLUMNS)
    .eq("id", addressId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new HttpError(502, `Address lookup failed: ${error.message}`);
  if (!data) throw new HttpError(400, "Delivery address not found.");
  return data as AddressRow;
}

async function loadArtwork(catalog: CatalogService, artworkId: string) {
  const artwork =
    (await catalog.getArtwork(artworkId)) ??
    (await getArtworkFromSupabase(artworkId));
  if (!artwork) throw new HttpError(404, `No artwork with id "${artworkId}"`);
  return artwork;
}

/**
 * Revenue split for artist originals — mirrors the old client-side logic but
 * reads the artist's opt-in + share straight from Supabase.
 */
async function revenueSplit(
  origin: string,
  artistId: string,
  price: number,
): Promise<{ artistCut: number | null; platformCut: number | null }> {
  if (origin !== "artist-original") return { artistCut: null, platformCut: null };
  const { data } = await supabaseAdmin()
    .from("artists")
    .select("sell_opt_in, revenue_share_pct")
    .eq("id", artistId)
    .maybeSingle();
  if (!data?.sell_opt_in) return { artistCut: null, platformCut: null };
  const pct = (data.revenue_share_pct as number | null) ?? 30;
  const artistCut = Math.round(price * (pct / 100) * 100) / 100;
  const platformCut = Math.round((price - artistCut) * 100) / 100;
  return { artistCut, platformCut };
}

/**
 * Step 1 — create the pending order + PaymentIntent. Everything that could
 * block fulfillment (config, address, variant) is validated HERE, so the
 * customer can't pay for an order we can't fulfil.
 */
export async function createCheckout(
  catalog: CatalogService,
  user: AuthedUser,
  input: CheckoutInput,
): Promise<CheckoutIntent> {
  if (!isCanvasSize(input.size)) {
    throw new HttpError(400, `Unknown canvas size "${input.size}".`);
  }
  if (!input.addressId) {
    throw new HttpError(400, "A delivery address is required.");
  }
  if (!env.printful.apiKey) {
    throw new HttpError(503, "Printful is not configured (PRINTFUL_API_KEY).");
  }
  const stripe = getStripe(); // 503s early when Stripe is unconfigured

  const size: CanvasSize = input.size;
  const artwork = await loadArtwork(catalog, input.artworkId);
  const address = await loadAddress(input.addressId, user.id);
  buildRecipient(address, user.email); // validate deliverability before paying
  await resolveVariantId(size); // validate the Printful variant exists

  const price = priceForSize(artwork.id, size);
  const { artistCut, platformCut } = await revenueSplit(
    artwork.origin,
    artwork.artistId,
    price,
  );

  const { data: order, error } = await supabaseAdmin()
    .from("canvas_orders")
    .insert({
      user_id: user.id,
      artwork_id: artwork.id,
      size,
      price,
      status: "pending_payment",
      address_id: address.id,
      currency: env.checkout.currency,
      ...(artistCut != null ? { artist_cut: artistCut } : {}),
      ...(platformCut != null ? { platform_cut: platformCut } : {}),
    })
    .select("id")
    .single();
  if (error || !order) {
    throw new HttpError(502, `Could not create the order: ${error?.message}`);
  }

  const amount = Math.round(price * 100);
  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.create({
      amount,
      currency: env.checkout.currency,
      automatic_payment_methods: { enabled: true },
      description: `Narsil canvas — ${artwork.title} (${size})`,
      ...(user.email ? { receipt_email: user.email } : {}),
      metadata: {
        order_id: order.id,
        artwork_id: artwork.id,
        size,
        user_id: user.id,
      },
    });
  } catch (err) {
    // No payment can ever arrive for this row — remove it rather than leaving
    // a dead pending_payment order behind.
    await supabaseAdmin().from("canvas_orders").delete().eq("id", order.id);
    throw err;
  }

  await supabaseAdmin()
    .from("canvas_orders")
    .update({ stripe_payment_intent_id: intent.id })
    .eq("id", order.id);

  return {
    orderId: order.id as string,
    clientSecret: intent.client_secret as string,
    amount,
    currency: env.checkout.currency,
    price,
  };
}

export interface OrderStatus {
  orderId: string;
  status: string;
  printfulOrderId: string | null;
}

function toStatus(order: OrderRow): OrderStatus {
  return {
    orderId: order.id,
    status: order.status,
    printfulOrderId: order.printful_order_id,
  };
}

async function loadOrder(orderId: string, userId?: string): Promise<OrderRow> {
  let query = supabaseAdmin()
    .from("canvas_orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new HttpError(502, `Order lookup failed: ${error.message}`);
  if (!data) throw new HttpError(404, "Order not found.");
  return data as OrderRow;
}

/** Read an order's fulfillment status (scoped to the owner). */
export async function getOrderStatus(
  orderId: string,
  userId: string,
): Promise<OrderStatus> {
  return toStatus(await loadOrder(orderId, userId));
}

/**
 * Step 2 — verify the payment with Stripe, then create the Printful order.
 * Idempotent and race-safe: the Stripe webhook and the app's finalize call can
 * both run it; only the caller that wins the `pending_payment →
 * paid` claim talks to Printful. Pass `userId` for app calls (ownership
 * check); the webhook omits it.
 */
export async function finalizeOrder(
  catalog: CatalogService,
  orderId: string,
  userId?: string,
): Promise<OrderStatus> {
  const order = await loadOrder(orderId, userId);

  // Terminal / already-fulfilled states — nothing to do.
  if (["submitted", "completed", "shipped", "cancelled"].includes(order.status)) {
    return toStatus(order);
  }
  if (!order.stripe_payment_intent_id) {
    throw new HttpError(409, "This order has no payment attached.");
  }

  const intent = await getStripe().paymentIntents.retrieve(
    order.stripe_payment_intent_id,
  );
  if (intent.status !== "succeeded") {
    throw new HttpError(402, "Payment has not completed for this order.");
  }

  // Claim the order. Exactly one concurrent caller gets rows back here; the
  // rest see the claim fail and simply report the current status. An order
  // stuck in `paid` (crash mid-fulfillment) is surfaced by fulfillment_error
  // and can be reset to `fulfillment_failed` to retry.
  const { data: claimed, error: claimError } = await supabaseAdmin()
    .from("canvas_orders")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .eq("id", order.id)
    .in("status", ["pending_payment", "fulfillment_failed"])
    .select(ORDER_COLUMNS);
  if (claimError) {
    throw new HttpError(502, `Could not update the order: ${claimError.message}`);
  }
  if (!claimed || claimed.length === 0) {
    return toStatus(await loadOrder(orderId));
  }

  try {
    if (!order.address_id) {
      throw new HttpError(409, "This order has no delivery address.");
    }
    const address = await loadAddress(order.address_id, order.user_id);
    const email =
      intent.receipt_email ?? intent.metadata?.email ?? undefined;
    const recipient = buildRecipient(address, email ?? undefined);

    const artwork = await loadArtwork(catalog, order.artwork_id);
    if (!artwork.image) {
      throw new HttpError(409, "This artwork has no print image.");
    }
    const imageUrl = fullResImageUrl(artwork.image, env.publicBaseUrl);

    const printful = await createPrintfulOrder({
      externalId: order.id,
      recipient,
      size: order.size as CanvasSize,
      imageUrl,
    });

    const { data: updated } = await supabaseAdmin()
      .from("canvas_orders")
      .update({
        status: "submitted",
        printful_order_id: String(printful.id),
        fulfillment_error: null,
      })
      .eq("id", order.id)
      .select(ORDER_COLUMNS)
      .single();

    console.log(
      `[checkout] order ${order.id} paid + submitted to Printful (#${printful.id}, ${printful.status})`,
    );
    return toStatus((updated as OrderRow) ?? { ...order, status: "submitted" });
  } catch (err) {
    // Payment IS captured — record the failure so fulfillment can be retried
    // (another finalize call re-claims from `fulfillment_failed`).
    const message = err instanceof Error ? err.message : "Unknown error";
    await supabaseAdmin()
      .from("canvas_orders")
      .update({ status: "fulfillment_failed", fulfillment_error: message })
      .eq("id", order.id);
    console.error(`[checkout] order ${order.id} fulfillment failed: ${message}`);
    throw err instanceof HttpError
      ? err
      : new HttpError(502, `Fulfillment failed: ${message}`);
  }
}
