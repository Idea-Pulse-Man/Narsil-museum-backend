/**
 * Printful API client (https://developers.printful.com) — the fulfillment leg
 * of canvas checkout. The backend only ever creates orders here AFTER Stripe
 * confirms the payment (see services/checkout.ts).
 */
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { CANVAS_SIZES, type CanvasSize } from "./pricing.js";

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

let variantCache: Record<CanvasSize, number> | null = null;

/**
 * Resolve the Printful catalog variant id for each canvas size — explicit env
 * overrides first, otherwise discovered once from the catalog product by
 * matching the variant's size string against the app's dimensions.
 */
export async function resolveVariantId(size: CanvasSize): Promise<number> {
  const override = env.printful.variantIds[size];
  if (override) return override;

  if (!variantCache) {
    const res = await fetch(
      `${PRINTFUL_API}/products/${env.printful.canvasProductId}`,
    );
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
      const id = env.printful.variantIds[key] ?? bySize.get(SIZE_DIMENSIONS[key]);
      if (!id) {
        throw new HttpError(
          503,
          `Printful product ${env.printful.canvasProductId} has no ` +
            `${SIZE_DIMENSIONS[key]} variant for size "${key}" — set ` +
            `PRINTFUL_VARIANT_${key.toUpperCase()}.`,
        );
      }
      resolved[key] = id;
    }
    variantCache = resolved;
    console.log(
      `[printful] canvas variants: ${CANVAS_SIZES.Small.dimensions}=${resolved.Small}, ` +
        `${CANVAS_SIZES.Medium.dimensions}=${resolved.Medium}, ` +
        `${CANVAS_SIZES.Large.dimensions}=${resolved.Large}`,
    );
  }
  return variantCache[size];
}

export interface PrintfulOrderInput {
  /** Our canvas_orders id — stored as Printful's external_id for tracing. */
  externalId: string;
  recipient: PrintfulRecipient;
  size: CanvasSize;
  /** Publicly fetchable print file (the artwork image). */
  imageUrl: string;
}

/**
 * Create the Printful order. Draft by default; PRINTFUL_CONFIRM_ORDERS=true
 * submits straight to fulfillment. Returns the Printful order id.
 */
export async function createPrintfulOrder(
  input: PrintfulOrderInput,
): Promise<{ id: number; status: string }> {
  const variantId = await resolveVariantId(input.size);
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
  return { id: result.id as number, status: String(result.status ?? "draft") };
}
