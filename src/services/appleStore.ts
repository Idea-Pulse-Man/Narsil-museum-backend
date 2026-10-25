/**
 * Apple App Store Server integration — signature verification and authoritative
 * subscription status.
 * ---------------------------------------------------------------------------
 * Two things arrive from Apple, and NEITHER is trusted on its face:
 *
 *   1. A signed transaction handed over by the app after a purchase or restore.
 *   2. A signed App Store Server Notification (V2) pushed to our webhook.
 *
 * Both are JWS blobs. We verify the signature chain against Apple's root CAs,
 * and then — rather than believing the payload's own view of the world — call
 * the App Store Server API for the CURRENT status. A signed transaction proves
 * a purchase happened once; only `getAllSubscriptionStatuses` says whether it
 * is still live right now, after any renewal, cancellation or refund.
 *
 * While the credentials are unset the whole tier no-ops: `appleConfigured()`
 * is false, the routes answer 503, and nobody is a subscriber. Canvas checkout
 * and the free download are unaffected.
 *
 * Environments: a Production deployment also accepts Sandbox data. App Review
 * buys with sandbox accounts against the production build, and TestFlight is
 * always sandbox, so a Production-only verifier rejects the reviewer's
 * purchase. Following Apple's guidance, Production is tried first and Sandbox
 * only when the payload says it belongs there. A Sandbox deployment stays
 * sandbox-only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from "@apple/app-store-server-library";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import type { SubscriptionStatus } from "./subscriptions.js";

/**
 * Apple's auto-renewable subscription status codes.
 * https://developer.apple.com/documentation/appstoreserverapi/status
 */
const APPLE_STATUS = {
  ACTIVE: 1,
  EXPIRED: 2,
  BILLING_RETRY: 3,
  GRACE_PERIOD: 4,
  REVOKED: 5,
} as const;

/**
 * Apple status → our entitlement status.
 *
 * Billing retry and grace period both map to `grace`, i.e. STILL ENTITLED.
 * Apple retries a failed charge for up to 60 days; cutting someone off on the
 * first failure punishes users whose card merely expired, and they usually
 * recover on their own.
 */
function mapStatus(appleStatus: number): SubscriptionStatus {
  switch (appleStatus) {
    case APPLE_STATUS.ACTIVE:
      return "active";
    case APPLE_STATUS.BILLING_RETRY:
    case APPLE_STATUS.GRACE_PERIOD:
      return "grace";
    case APPLE_STATUS.REVOKED:
      return "revoked";
    default:
      return "expired";
  }
}

export interface EntitlementSnapshot {
  originalTransactionId: string;
  productId: string;
  status: SubscriptionStatus;
  expiresAtMs: number | null;
  autoRenew: boolean;
  environment: "Production" | "Sandbox";
}

/** Every credential must be present — a half-configured tier fails obscurely. */
export function appleConfigured(): boolean {
  const { privateKey, keyId, issuerId, bundleId } = env.apple;
  return Boolean(privateKey && keyId && issuerId && bundleId);
}

type AppleEnv = EntitlementSnapshot["environment"];

/** Environments to try, in order. See the header for why Production falls back. */
function environments(): AppleEnv[] {
  return env.apple.environment === "Sandbox" ? ["Sandbox"] : ["Production", "Sandbox"];
}

const toLibraryEnv = (e: AppleEnv): Environment =>
  e === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;

/** True when Apple's library rejected a payload only for its environment. */
const isWrongEnvironment = (err: unknown): boolean =>
  err instanceof VerificationException &&
  err.status === VerificationStatus.INVALID_ENVIRONMENT;

/** Any signature / identity failure — the caller's data, not our outage. */
export function isVerificationError(err: unknown): boolean {
  return err instanceof VerificationException;
}

/**
 * Run `fn` with each allowed environment's verifier until one accepts the
 * payload. Only an environment mismatch moves on to the next one; a bad
 * signature fails immediately.
 */
async function withVerifier<T>(
  fn: (verifier: SignedDataVerifier, environment: AppleEnv) => Promise<T>,
): Promise<T> {
  const envs = environments();
  for (let i = 0; i < envs.length; i += 1) {
    try {
      return await fn(signedDataVerifier(envs[i]), envs[i]);
    } catch (err) {
      if (i < envs.length - 1 && isWrongEnvironment(err)) continue;
      throw err;
    }
  }
  throw new Error("No App Store environment configured.");
}

/**
 * Apple's root CA certificates, read once from `APPLE_ROOT_CA_DIR`. Without
 * them `SignedDataVerifier` cannot validate a chain, so an empty directory is a
 * hard error rather than a silent downgrade to "trust anything".
 */
let rootCAs: Buffer[] | null = null;

function loadRootCAs(): Buffer[] {
  if (rootCAs) return rootCAs;

  const dir = isAbsolute(env.apple.rootCaDir)
    ? env.apple.rootCaDir
    : resolve(process.cwd(), env.apple.rootCaDir);

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.(cer|der|pem)$/i.test(f));
  } catch {
    throw new Error(
      `Apple root CAs not found at "${dir}". Download them from ` +
        `https://www.apple.com/certificateauthority/ (Apple Root CA - G3) and ` +
        `set APPLE_ROOT_CA_DIR.`,
    );
  }
  if (files.length === 0) {
    throw new Error(`Apple root CA directory "${dir}" contains no certificates.`);
  }

  rootCAs = files.map((f) => readFileSync(join(dir, f)));
  return rootCAs;
}

const apiClients = new Map<AppleEnv, AppStoreServerAPIClient>();
const verifiers = new Map<AppleEnv, SignedDataVerifier>();

function client(environment: AppleEnv): AppStoreServerAPIClient {
  let c = apiClients.get(environment);
  if (!c) {
    c = new AppStoreServerAPIClient(
      env.apple.privateKey,
      env.apple.keyId,
      env.apple.issuerId,
      env.apple.bundleId,
      toLibraryEnv(environment),
    );
    apiClients.set(environment, c);
  }
  return c;
}

function signedDataVerifier(environment: AppleEnv): SignedDataVerifier {
  let v = verifiers.get(environment);
  if (!v) {
    v = new SignedDataVerifier(
      loadRootCAs(),
      // Online revocation checks — worth the extra round trip, this runs at
      // most once per purchase or lifecycle event, not per request.
      true,
      toLibraryEnv(environment),
      env.apple.bundleId,
      env.apple.appAppleId ?? undefined,
    );
    verifiers.set(environment, v);
  }
  return v;
}

/**
 * Verify a signed transaction from the app and return its
 * `originalTransactionId` — the stable id everything else is keyed on — and
 * the environment it belongs to. Throws when the signature, bundle id or
 * environment doesn't match.
 */
export async function verifyTransaction(
  signedTransaction: string,
): Promise<{ originalTransactionId: string; productId: string; environment: AppleEnv }> {
  const { payload, environment } = await withVerifier(async (verifier, environment) => ({
    payload: await verifier.verifyAndDecodeTransaction(signedTransaction),
    environment,
  }));

  const originalTransactionId = payload.originalTransactionId;
  const productId = payload.productId;
  if (!originalTransactionId || !productId) {
    throw new HttpError(400, "Signed transaction is missing its identifiers.");
  }
  if (!env.apple.productIds.includes(productId)) {
    throw new HttpError(400, `Unexpected product "${productId}" in transaction.`);
  }
  return { originalTransactionId, productId, environment };
}

/** Verify an App Store Server Notification V2 body. */
export async function verifyNotification(signedPayload: string): Promise<{
  notificationType: string;
  subtype?: string;
  originalTransactionId: string | null;
  notificationUUID: string;
  environment: AppleEnv;
}> {
  const { payload, environment } = await withVerifier(async (verifier, environment) => ({
    payload: await verifier.verifyAndDecodeNotification(signedPayload),
    environment,
  }));

  // The transaction id lives inside a nested signed blob; decode that too.
  let originalTransactionId: string | null = null;
  const signedTx = payload.data?.signedTransactionInfo;
  if (signedTx) {
    const tx = await signedDataVerifier(environment).verifyAndDecodeTransaction(signedTx);
    originalTransactionId = tx.originalTransactionId ?? null;
  }

  return {
    notificationType: String(payload.notificationType ?? ""),
    subtype: payload.subtype ? String(payload.subtype) : undefined,
    originalTransactionId,
    notificationUUID: String(payload.notificationUUID ?? ""),
    environment,
  };
}

/**
 * Ask Apple for the CURRENT state of a subscription. This is the authoritative
 * read — used after a purchase, after a restore, and on every notification, so
 * we never have to hand-map each notification type to a status and get one
 * of them subtly wrong. `environment` is the one the transaction was verified
 * in — a sandbox transaction is unknown to the production status API.
 */
export async function resolveEntitlement(
  originalTransactionId: string,
  environment: AppleEnv,
): Promise<EntitlementSnapshot | null> {
  const response = await client(environment).getAllSubscriptionStatuses(
    originalTransactionId,
  );
  const verifier = signedDataVerifier(environment);

  for (const group of response.data ?? []) {
    for (const item of group.lastTransactions ?? []) {
      if (item.originalTransactionId !== originalTransactionId) continue;
      if (!item.signedTransactionInfo) continue;

      const tx = await verifier.verifyAndDecodeTransaction(item.signedTransactionInfo);

      let autoRenew = false;
      if (item.signedRenewalInfo) {
        const renewal = await verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo);
        autoRenew = renewal.autoRenewStatus === 1;
      }

      return {
        originalTransactionId,
        productId: tx.productId ?? "",
        status: mapStatus(Number(item.status)),
        expiresAtMs: tx.expiresDate ? Number(tx.expiresDate) : null,
        autoRenew,
        environment,
      };
    }
  }

  return null;
}
