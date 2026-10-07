/**
 * Printful API client (https://developers.printful.com) — the fulfillment leg
 * of canvas checkout. The backend only ever creates orders here AFTER Stripe
 * confirms the payment (see services/checkout.ts).
 */
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { CANVAS_SIZES, type CanvasSize, type ProductType } from "./pricing.js";

const PRINTFUL_API = "https://api.printful.com";

/** App size → catalog dimensions ("12x16") used to match Printful variants. */
const SIZE_DIMENSIONS: Record<CanvasSize, string> = {
  Small: "12x16",
  Medium: "18x24",
  Large: "24x36",
};

export interface PrintfulRecipient {
  name: string;
  address1: string;
  address2?: string;
  city: string;
  state_code?: string;
  country_code: string;
  zip?: string;
  phone?: string;
  email?: string;
}

function headers(): Record<string, string> {
  if (!env.printful.apiKey) {
    throw new HttpError(503, "Printful is not configured (PRINTFUL_API_KEY).");
  }
  return {
    Authorization: `Bearer ${env.printful.apiKey}`,
    "Content-Type": "application/json",
    ...(env.printful.storeId ? { "X-PF-Store-Id": env.printful.storeId } : {}),
  };
}

async function printfulJson(res: Response): Promise<any> {
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const message =
      body?.result && typeof body.result === "string"
        ? body.result
        : (body?.error?.message ?? `Printful request failed (${res.status})`);
    throw new HttpError(502, `Printful: ${message}`);
  }
  return body?.result;
}

/** "12″×16″" / '12x16 in' / "12 × 16" → "12x16" (for variant matching). */
function normalizeDimensions(value: string): string | null {
  const match = value.match(/(\d+)\s*[^\d]+\s*(\d+)/);
  return match ? `${match[1]}x${match[2]}` : null;
}

/** Printful catalog product per app product. Canvas is configurable. */
function printfulProductId(product: ProductType): number {
  return product === "canvas" ? env.printful.canvasProductId : env.printful.posterProductId;
}

/** Variant ids per product, refreshed daily so catalog changes need no restart. */
const VARIANT_TTL_MS = 24 * 60 * 60 * 1000;
const variantCache = new Map<ProductType, { ids: Record<CanvasSize, number>; at: number }>();

/**
 * Resolve the Printful catalog variant id for a product + size — explicit env
 * overrides first (canvas only), otherwise discovered from the catalog
 * product by matching the variant's size string against the app's dimensions.
 */
export async function resolveVariantId(
  size: CanvasSize,
  product: ProductType = "canvas",
): Promise<number> {
  if (product === "canvas") {
    const override = env.printful.variantIds[size];
    if (override) return override;
  }

  const cached = variantCache.get(product);
  if (cached && Date.now() - cached.at < VARIANT_TTL_MS) return cached.ids[size];

  const productId = printfulProductId(product);
  const res = await fetch(`${PRINTFUL_API}/products/${productId}`);
  const result = await printfulJson(res);
  const variants: Array<{ id: number; size?: string; name?: string }> =
    result?.variants ?? [];

  const bySize = new Map<string, number>();
  for (const variant of variants) {
    const dims = normalizeDimensions(variant.size ?? variant.name ?? "");
    if (dims && !bySize.has(dims)) bySize.set(dims, variant.id);
  }

  const resolved = {} as Record<CanvasSize, number>;
  for (const key of Object.keys(SIZE_DIMENSIONS) as CanvasSize[]) {
    const id =
      (product === "canvas" ? env.printful.variantIds[key] : null) ??
      bySize.get(SIZE_DIMENSIONS[key]);
    if (!id) {
      throw new HttpError(
        503,
        `Printful product ${productId} has no ${SIZE_DIMENSIONS[key]} variant ` +
          `for ${product} size "${key}".`,
      );
    }
    resolved[key] = id;
  }
  variantCache.set(product, { ids: resolved, at: Date.now() });
  console.log(
    `[printful] ${product} variants: ${CANVAS_SIZES.Small.dimensions}=${resolved.Small}, ` +
      `${CANVAS_SIZES.Medium.dimensions}=${resolved.Medium}, ` +
      `${CANVAS_SIZES.Large.dimensions}=${resolved.Large}`,
  );
  return resolved[size];
}

export interface PrintfulOrderInput {
  /** Our canvas_orders id — stored as Printful's external_id for tracing. */
  externalId: string;
  recipient: PrintfulRecipient;
  size: CanvasSize;
  product: ProductType;
  /** Publicly fetchable print file (the artwork image). */
  imageUrl: string;
}

/**
 * Create the Printful order. Draft by default; PRINTFUL_CONFIRM_ORDERS=true
 * submits straight to fulfillment. Returns the Printful order id and what
 * Printful will bill us for it (print + shipping + tax), when it reports one.
 */
export async function createPrintfulOrder(
  input: PrintfulOrderInput,
): Promise<{ id: number; status: string; cost: number | null }> {
  const variantId = await resolveVariantId(input.size, input.product);
  const confirm = env.printful.confirmOrders ? 1 : 0;

  const res = await fetch(`${PRINTFUL_API}/orders?confirm=${confirm}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      external_id: input.externalId,
      recipient: input.recipient,
      items: [
        {
          variant_id: variantId,
          quantity: 1,
          files: [{ url: input.imageUrl }],
        },
      ],
    }),
  });
  const result = await printfulJson(res);
  const cost = Number(result.costs?.total);
  return {
    id: result.id as number,
    status: String(result.status ?? "draft"),
    cost: Number.isFinite(cost) && cost > 0 ? cost : null,
  };
}

/** The parts of a Printful order the status webhook needs. */
export interface PrintfulOrderStatus {
  status: string;
  shipments: {
    carrier?: string;
    tracking_number?: string;
    tracking_url?: string;
    ship_date?: string;
  }[];
}

/**
 * Read an order's live status from Printful by our external_id (the
 * canvas_orders id). Returns null when Printful has no such order. Used by the
 * webhook to confirm an event against the source of truth instead of trusting
 * the payload.
 */
export async function getPrintfulOrder(
  externalId: string,
): Promise<PrintfulOrderStatus | null> {
  const res = await fetch(
    `${PRINTFUL_API}/orders/@${encodeURIComponent(externalId)}`,
    { headers: headers() },
  );
  if (res.status === 404) return null;
  const result = await printfulJson(res);
  return {
    status: String(result?.status ?? ""),
    shipments: Array.isArray(result?.shipments) ? result.shipments : [],
  };
}

/** A Printful order waiting for someone to confirm it in the dashboard. */
export interface PrintfulDraft {
  printfulId: number;
  /** Our canvas_orders id, when the order came from checkout. */
  orderId: string | null;
  createdAt: string;
  /** What Printful will bill on confirmation, when it has priced it. */
  cost: number | null;
  city: string | null;
}

/**
 * Orders still in Printful's `draft` state. With PRINTFUL_CONFIRM_ORDERS
 * off, every paid order lands here and nothing ships until it's confirmed,
 * so the admin dashboard polls this to raise an alert.
 */
export async function listPrintfulDrafts(): Promise<PrintfulDraft[]> {
  const res = await fetch(`${PRINTFUL_API}/orders?status=draft&limit=100`, {
    headers: headers(),
  });
  const result = (await printfulJson(res)) as unknown;
  const rows = Array.isArray(result) ? (result as Record<string, any>[]) : [];
  return rows.map((o) => {
    const cost = Number(o.costs?.total);
    return {
      printfulId: Number(o.id),
      orderId: typeof o.external_id === "string" ? o.external_id : null,
      createdAt: new Date(Number(o.created) * 1000).toISOString(),
      cost: Number.isFinite(cost) && cost > 0 ? cost : null,
      city: typeof o.recipient?.city === "string" ? o.recipient.city : null,
    };
  });
}
