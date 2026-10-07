/**
 * First-party analytics + error log (supabase/telemetry.sql).
 *
 * The app batches anonymous events and errors to POST /api/telemetry; server
 * errors are written from the error handler. Rows carry a random install id,
 * never a user id, email or IP. Everything here is best-effort: telemetry
 * must never break a request or crash the process.
 */
import { supabaseAdmin } from "./supabaseAdmin.js";

const MAX_ITEMS = 50;
const RETENTION_DAYS = 90;

type Props = Record<string, string | number | boolean | null>;

export interface TelemetryBatch {
  installId: string;
  sessionId: string;
  platform: string;
  appVersion: string;
  items: { kind: "event" | "error"; name: string; props?: Props; at: string }[];
}

const clip = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

/** Keep only small scalar props — no nested objects, no long strings. */
function cleanProps(raw: unknown): Props {
  const out: Props = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 12)) {
    if (typeof v === "number" || typeof v === "boolean" || v === null) out[k.slice(0, 40)] = v;
    else if (typeof v === "string") out[k.slice(0, 40)] = v.slice(0, 200);
  }
  return out;
}

/** Validate an untrusted batch from the app. Null when it isn't one. */
export function parseBatch(body: unknown): TelemetryBatch | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const installId = clip(b.installId, 64);
  if (!installId || !Array.isArray(b.items)) return null;
  const items = b.items
    .slice(0, MAX_ITEMS)
    .filter(
      (i): i is Record<string, unknown> =>
        !!i && typeof i === "object" && typeof (i as { name?: unknown }).name === "string",
    )
    .map((i) => ({
      kind: i.kind === "error" ? ("error" as const) : ("event" as const),
      name: String(i.name).slice(0, 300),
      props: i.kind === "error" ? (i.props as Props | undefined) : cleanProps(i.props),
      at: clip(i.at, 40) ?? new Date().toISOString(),
    }));
  return {
    installId,
    sessionId: clip(b.sessionId, 64) ?? installId,
    platform: clip(b.platform, 20) ?? "unknown",
    appVersion: clip(b.appVersion, 20) ?? "",
    items,
  };
}

let lastPurge = 0;

async function purgeOld(): Promise<void> {
  if (Date.now() - lastPurge < 24 * 60 * 60 * 1000) return;
  lastPurge = Date.now();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const db = supabaseAdmin();
  await db.from("app_events").delete().lt("created_at", cutoff);
  await db.from("app_errors").delete().lt("created_at", cutoff);
}

export async function storeBatch(batch: TelemetryBatch): Promise<void> {
  const db = supabaseAdmin();
  const base = {
    install_id: batch.installId,
    session_id: batch.sessionId,
    platform: batch.platform,
    app_version: batch.appVersion,
  };
  const events = batch.items
    .filter((i) => i.kind === "event")
    .map((i) => ({ ...base, name: i.name.slice(0, 60), props: i.props ?? {}, created_at: i.at }));
  const errors = batch.items
    .filter((i) => i.kind === "error")
    .map((i) => ({
      install_id: batch.installId,
      platform: batch.platform,
      app_version: batch.appVersion,
      source: "app",
      message: i.name,
      context: clip(i.props?.context, 200),
      stack: clip(i.props?.stack, 2000),
      url: clip(i.props?.url, 200),
      created_at: i.at,
    }));
  if (events.length) {
    const { error } = await db.from("app_events").insert(events);
    if (error) console.warn(`[telemetry] events insert failed: ${error.message}`);
  }
  if (errors.length) {
    const { error } = await db.from("app_errors").insert(errors);
    if (error) console.warn(`[telemetry] errors insert failed: ${error.message}`);
  }
  void purgeOld().catch(() => {});
}

/** Same message logged at most once a minute — a failing upstream can't flood. */
const recentServerErrors = new Map<string, number>();

export function logServerError(message: string, context: string, stack?: string): void {
  const key = `${message}|${context}`;
  const now = Date.now();
  if ((recentServerErrors.get(key) ?? 0) > now - 60_000) return;
  recentServerErrors.set(key, now);
  if (recentServerErrors.size > 500) recentServerErrors.clear();
  try {
    void supabaseAdmin()
      .from("app_errors")
      .insert({
        source: "server",
        message: message.slice(0, 300),
        context: context.slice(0, 200),
        stack: stack?.slice(0, 2000) ?? null,
        platform: "server",
      })
      .then(({ error }) => {
        if (error) console.warn(`[telemetry] server error log failed: ${error.message}`);
      });
  } catch {
    // Supabase not configured (local dev) — console output is enough.
  }
}
