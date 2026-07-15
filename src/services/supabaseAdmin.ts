/**
 * Shared service-role Supabase client for checkout: verifies user JWTs and
 * reads/writes user-scoped rows (addresses, canvas_orders) that RLS would
 * otherwise hide from the server.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

let client: SupabaseClient | null = null;

/** The service-role client, or a 503 when Supabase isn't configured. */
export function supabaseAdmin(): SupabaseClient {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    throw new HttpError(503, "Supabase is not configured on the server.");
  }
  if (!client) {
    client = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
