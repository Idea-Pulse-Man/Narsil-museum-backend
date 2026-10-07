/**
 * iPhone push notifications, sent straight to Apple (APNs, HTTP/2 +
 * token-based auth). No third-party service.
 *
 * Needs APNS_KEY / APNS_KEY_ID / APPLE_TEAM_ID (config/env.ts → apns). While
 * any is unset every send is a silent no-op, like the AI and Apple tiers.
 * Device tokens live in push_tokens (supabase/push-notifications.sql);
 * tokens Apple reports as dead are deleted.
 *
 * Every function here is best-effort: a failed notification must never fail
 * the order, webhook or cron that triggered it.
 */
import http2 from "node:http2";
import { sign } from "node:crypto";
import { env } from "../config/env.js";
import { supabaseAdmin } from "./supabaseAdmin.js";

export interface PushMessage {
  title: string;
  body: string;
  /** Delivered to the app on tap, e.g. { type: "artwork", id: "met-1" }. */
  data?: Record<string, string>;
}

export function pushConfigured(): boolean {
  return Boolean(env.apns.key && env.apns.keyId && env.apns.teamId);
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/** ES256 JWT in the form APNs expects (raw r||s signature, not DER). */
export function signApnsJwt(
  key: string,
  keyId: string,
  teamId: string,
  issuedAt = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: issuedAt }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${b64url(signature)}`;
}

let cachedJwt: { token: string; at: number } | null = null;

/** APNs provider token — valid up to an hour; refreshed every 50 minutes. */
function providerToken(): string {
  if (cachedJwt && Date.now() - cachedJwt.at < 50 * 60_000) return cachedJwt.token;
  cachedJwt = {
    token: signApnsJwt(env.apns.key, env.apns.keyId, env.apns.teamId),
    at: Date.now(),
  };
  return cachedJwt.token;
}

let session: http2.ClientHttp2Session | null = null;

function apnsSession(): http2.ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session;
  const host = env.apns.sandbox
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
  session = http2.connect(host);
  session.on("error", () => {
    session = null;
  });
  // Don't keep the process alive just for an idle push connection.
  session.unref();
  return session;
}

/** Send to one device. Resolves to the APNs status and reason. */
function sendOne(
  deviceToken: string,
  message: PushMessage,
): Promise<{ status: number; reason?: string }> {
  return new Promise((resolve) => {
    let req: http2.ClientHttp2Stream;
    try {
      req = apnsSession().request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken()}`,
        "apns-topic": env.apns.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      });
    } catch (err) {
      resolve({ status: 0, reason: err instanceof Error ? err.message : "connect failed" });
      return;
    }
    let status = 0;
    let body = "";
    req.setEncoding("utf8");
    req.setTimeout(15_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      let reason: string | undefined;
      try {
        reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
      } catch {
        reason = body.slice(0, 100) || undefined;
      }
      resolve({ status, reason });
    });
    req.on("error", (err) => resolve({ status: 0, reason: err.message }));
    req.end(
      JSON.stringify({
        aps: { alert: { title: message.title, body: message.body }, sound: "default" },
        ...(message.data ?? {}),
      }),
    );
  });
}

/** Tokens Apple says will never work again. */
const DEAD_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

/** Send to many devices (8 at a time); deletes dead tokens. Returns sends that succeeded. */
export async function sendToTokens(tokens: string[], message: PushMessage): Promise<number> {
  if (!pushConfigured() || tokens.length === 0) return 0;
  let sent = 0;
  const dead: string[] = [];
  for (let i = 0; i < tokens.length; i += 8) {
    const batch = tokens.slice(i, i + 8);
    const results = await Promise.all(batch.map((t) => sendOne(t, message)));
    results.forEach((r, j) => {
      if (r.status === 200) sent++;
      else if (r.status === 410 || (r.reason && DEAD_REASONS.has(r.reason))) dead.push(batch[j]);
      else console.warn(`[push] APNs ${r.status} ${r.reason ?? ""}`);
    });
  }
  if (dead.length) {
    await supabaseAdmin().from("push_tokens").delete().in("token", dead);
  }
  return sent;
}

async function tokensFor(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { data, error } = await supabaseAdmin()
    .from("push_tokens")
    .select("token")
    .in("user_id", userIds);
  if (error) {
    console.warn(`[push] token lookup failed: ${error.message}`);
    return [];
  }
  return (data ?? []).map((r) => (r as { token: string }).token);
}

/** Notify specific accounts. Never throws. */
export async function notifyUsers(userIds: string[], message: PushMessage): Promise<void> {
  if (!pushConfigured()) return;
  try {
    await sendToTokens(await tokensFor(userIds), message);
  } catch (err) {
    console.warn(`[push] notifyUsers failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Notify every admin account. Never throws. */
export async function notifyAdmins(message: PushMessage): Promise<void> {
  if (!pushConfigured()) return;
  try {
    const { data } = await supabaseAdmin().from("profiles").select("id").eq("role", "admin");
    const ids = (data ?? []).map((r) => (r as { id: string }).id);
    await sendToTokens(await tokensFor(ids), message);
  } catch (err) {
    console.warn(`[push] notifyAdmins failed: ${err instanceof Error ? err.message : err}`);
  }
}
