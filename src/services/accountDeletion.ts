/**
 * In-app account deletion (App Store Review Guideline 5.1.1(v)).
 *
 * Deletes the Supabase auth user. Almost everything personal goes with it
 * through `on delete cascade` (profile, collections, follows, comments,
 * addresses, quiz rows, support threads, subscriptions). Files the user
 * uploaded (avatar, artwork images) and the artworks / artist profile they
 * created are removed here first.
 *
 * Canvas orders are KEPT as financial records, detached from the person
 * (`user_id` → null). That needs supabase/account-deletion.sql; without it
 * the detach step fails and nothing is deleted, so orders can never vanish.
 *
 * An order that is paid but not yet handed to Printful blocks deletion: its
 * fulfillment still needs the saved delivery address.
 */
import { HttpError } from "../utils/httpError.js";
import { supabaseAdmin } from "./supabaseAdmin.js";

/** Storage buckets keyed by `<user id>/…`. */
const USER_BUCKETS = ["avatars", "artworks"];

/** Order states where Printful hasn't got the order (and its address) yet. */
const IN_FLIGHT = ["paid", "fulfillment_failed"];

async function removeUserFiles(userId: string): Promise<void> {
  const storage = supabaseAdmin().storage;
  for (const bucket of USER_BUCKETS) {
    const { data, error } = await storage.from(bucket).list(userId, { limit: 1000 });
    if (error) {
      console.warn(`[account] list ${bucket}/${userId} failed: ${error.message}`);
      continue;
    }
    const paths = (data ?? []).map((f) => `${userId}/${f.name}`);
    if (paths.length === 0) continue;
    const { error: removeError } = await storage.from(bucket).remove(paths);
    if (removeError) {
      console.warn(`[account] remove ${bucket}/${userId} failed: ${removeError.message}`);
    }
  }
}

/**
 * Remove the artworks this user uploaded and their artist profile. A work
 * that someone has ordered as a print is hidden instead (the order row
 * still points at it).
 */
async function removeUserArtworks(userId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: works } = await db
    .from("artworks")
    .select("id")
    .eq("created_by", userId);
  for (const { id } of (works ?? []) as { id: string }[]) {
    const { count } = await db
      .from("canvas_orders")
      .select("id", { count: "exact", head: true })
      .eq("artwork_id", id);
    const { error } = count
      ? await db.from("artworks").update({ hidden: true }).eq("id", id)
      : await db.from("artworks").delete().eq("id", id);
    if (error) {
      // e.g. other rows still reference it — never leave it public.
      await db.from("artworks").update({ hidden: true }).eq("id", id);
    }
  }

  const { data: artists } = await db.from("artists").select("id").eq("user_id", userId);
  for (const { id } of (artists ?? []) as { id: string }[]) {
    const { error } = await db.from("artists").delete().eq("id", id);
    if (error) {
      // Still referenced by a hidden, ordered work: unlink and stop selling.
      await db
        .from("artists")
        .update({ sell_opt_in: false, user_id: null })
        .eq("id", id);
    }
  }
}

export async function deleteAccount(userId: string): Promise<void> {
  const db = supabaseAdmin();

  const { count: inFlight, error: inFlightError } = await db
    .from("canvas_orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", IN_FLIGHT);
  if (inFlightError) {
    throw new HttpError(502, `Could not check your orders: ${inFlightError.message}`);
  }
  if (inFlight) {
    throw new HttpError(
      409,
      "You have a print order that is still being prepared. You can delete your " +
        "account once it has been sent to the printer — usually within a day.",
    );
  }

  // Keep orders as anonymous financial records. Fails (and stops everything)
  // if supabase/account-deletion.sql hasn't made user_id nullable yet.
  const { error: detachError } = await db
    .from("canvas_orders")
    .update({ user_id: null, address_id: null })
    .eq("user_id", userId);
  if (detachError) {
    console.error(`[account] detach orders for ${userId} failed: ${detachError.message}`);
    throw new HttpError(
      503,
      "Account deletion is temporarily unavailable. Please try again later.",
    );
  }

  await removeUserArtworks(userId);
  await removeUserFiles(userId);

  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) {
    throw new HttpError(502, `Could not delete the account: ${error.message}`);
  }
  console.log(`[account] deleted user ${userId}`);
}
