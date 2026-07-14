/**
 * Thin wrapper over the global `fetch` (Node 18+) that adds a timeout, a
 * descriptive User-Agent, and typed JSON parsing with clear error messages.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = "narsil-museum-backend/1.0 (+https://github.com/narsil)";

/** A non-OK HTTP response, carrying the status so callers can tell a
 *  rate-limit (429/503) apart from a plain miss (404). */
export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`GET ${url} → ${status}`);
  }
}

/** Statuses worth retrying: throttles and transient server errors. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503;
}

/** Backoff waits between retries — long enough to ride out a throttle window. */
const RETRY_WAITS_MS = [1_000, 4_000, 15_000, 60_000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...rest.headers,
      },
    });

    if (!res.ok) {
      throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`GET ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetchJson` with typed status errors and retry-with-backoff on throttles
 * (429/5xx) and timeouts. A persistent throttle exhausts the retries and the
 * final `HttpStatusError` propagates — callers decide whether that fails the
 * run loudly (preferred) or skips the record.
 */
export async function fetchJsonRetry<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 4, ...rest } = init;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...rest,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...rest.headers,
        },
      });
      if (!res.ok) throw new HttpStatusError(res.status, url);
      return (await res.json()) as T;
    } catch (err) {
      const retryable =
        (err instanceof HttpStatusError && isRetryableStatus(err.status)) ||
        (err instanceof Error && err.name === "AbortError");
      if (!retryable || attempt >= retries) throw err;
      await sleep(RETRY_WAITS_MS[Math.min(attempt, RETRY_WAITS_MS.length - 1)]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Split an array into fixed-size chunks (for batched upstream requests). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
