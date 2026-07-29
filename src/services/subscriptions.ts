/**
 * Narsil Pro entitlement — the single source of truth for "is this user a
 * subscriber?".
 * ---------------------------------------------------------------------------
 * Every paid perk reads `isSubscriber()` server-side:
 *   · the 20% canvas discount   (services/checkout.ts)
 *   · the high-resolution download gate (routes/artworks.ts)
 *
 * The app is told its own state via GET /api/me/subscription, but that answer
 * is for rendering only — nothing trusts a flag that arrived from the client.
 *
 * Rows are written only from Apple: routes/apple.ts handles both the app's
 * post-purchase verification and App Store Server Notifications V2.
 */
import { supabaseAdmin } from "./supabaseAdmin.js";

export type SubscriptionStatus = "active" | "grace" | "expired" | "revoked";

/** Statuses that still grant the perks. */
const ENTITLED: readonly SubscriptionStatus[] = ["active", "grace"];

const COLUMNS =
  "user_id, original_transaction_id, product_id, status, expires_at, auto_renew, environment";

interface SubscriptionRow {
  user_id: string;
  original_transaction_id: string;
  product_id: string;
  status: SubscriptionStatus;
  expires_at: string | null;
  auto_renew: boolean;
  environment: string;
}

/** What the app is told about its own subscription. */
export interface SubscriptionView {
  active: boolean;
  status: SubscriptionStatus | null;
  productId: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
}

const NONE: SubscriptionView = {
  active: false,
  status: null,
  productId: null,
  expiresAt: null,
  autoRenew: false,
};

/** An entitled row is `active`/`grace` with an expiry still in the future. */
function isEntitled(row: SubscriptionRow | null): boolean {
  if (!row?.expires_at) return false;
  if (!ENTITLED.includes(row.status)) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

/**
 * The user's most relevant subscription row: the one that expires furthest in
 * the future. A user can accumulate rows (an old lapsed subscription plus a
 * fresh one), and the newest expiry is always the one that decides entitlement.
 */
async function loadRow(userId: string): Promise<SubscriptionRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("subscriptions")
    .select(COLUMNS)
    .eq("user_id", userId)
    .order("expires_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // Fail CLOSED. A lookup failure must not hand out the discount or the
    // high-res download — the cost of a wrongly-denied perk is one support
    // ticket, the cost of a wrongly-granted one is money on every order.
    console.error(`[subscriptions] lookup failed for ${userId}: ${error.message}`);
    return null;
  }
  return (data as SubscriptionRow | null) ?? null;
}

/** Server-side entitlement check. The only function the paid perks may call. */
export async function isSubscriber(userId: string): Promise<boolean> {
  return isEntitled(await loadRow(userId));
}

/** The shape GET /api/me/subscription returns. */
export async function getSubscription(
  userId: string,
): Promise<SubscriptionView> {
  const row = await loadRow(userId);
  if (!row) return NONE;
  return {
    active: isEntitled(row),
    status: row.status,
    productId: row.product_id,
    expiresAt: row.expires_at,
    autoRenew: row.auto_renew,
  };
}

export interface UpsertSubscriptionInput {
  userId: string;
  /** Apple's stable per-subscriber id — the conflict key. */
  originalTransactionId: string;
  productId: string;
  status: SubscriptionStatus;
  /** Apple's `expiresDate` in ms. */
  expiresAtMs: number | null;
  autoRenew: boolean;
  environment: "Production" | "Sandbox";
}

/**
 * Write (or move) an entitlement. Keyed on `original_transaction_id`, so a
 * renewal, a restore on a new device, and a notification replay all land on
 * the same row rather than creating duplicates.
 *
 * `user_id` is part of the update: when someone restores a purchase while
 * signed into a different account, the subscription MOVES to that account
 * rather than being duplicated. Apple allows one active subscription per Apple
 * ID, so exactly one Supabase user should hold it at a time.
 */
export async function upsertSubscription(
  input: UpsertSubscriptionInput,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("subscriptions")
    .upsert(
      {
        user_id: input.userId,
        original_transaction_id: input.originalTransactionId,
        product_id: input.productId,
        status: input.status,
        expires_at: input.expiresAtMs
          ? new Date(input.expiresAtMs).toISOString()
          : null,
        auto_renew: input.autoRenew,
        environment: input.environment,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "original_transaction_id" },
    );

  if (error) {
    throw new Error(`Could not save the subscription: ${error.message}`);
  }
}

/**
 * Update an existing entitlement found by Apple's transaction id alone — the
 * path notifications take, since Apple's payload carries no Supabase user id.
 * Returns false when the row is unknown (a notification that arrived before
 * the app's verify call; Apple retries, so the next delivery will land).
 */
export async function updateSubscriptionByTransaction(
  originalTransactionId: string,
  patch: {
    status?: SubscriptionStatus;
    expiresAtMs?: number | null;
    autoRenew?: boolean;
    productId?: string;
  },
): Promise<boolean> {
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.autoRenew !== undefined) update.auto_renew = patch.autoRenew;
  if (patch.productId !== undefined) update.product_id = patch.productId;
  if (patch.expiresAtMs !== undefined) {
    update.expires_at = patch.expiresAtMs
      ? new Date(patch.expiresAtMs).toISOString()
      : null;
  }

  const { data, error } = await supabaseAdmin()
    .from("subscriptions")
    .update(update)
    .eq("original_transaction_id", originalTransactionId)
    .select("user_id");

  if (error) {
    throw new Error(`Could not update the subscription: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}
