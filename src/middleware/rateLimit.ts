import type { NextFunction, Request, Response } from "express";

/**
 * In-memory, fixed-window rate limiter keyed by client IP.
 *
 * The backend runs as a single pm2 process behind CloudFront, so a per-process
 * counter is enough to stop one client from looping an expensive endpoint (a
 * multi-MB master download, a Wikidata lookup) and running up egress. Counters
 * reset on restart, which is fine for abuse control.
 *
 * `req.ip` is only the real viewer IP when `trust proxy` is set to the number
 * of proxies in front of the app (see `env.trustProxy` in app.ts).
 */
export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Requests allowed per client per window. */
  max: number;
  /** Shown to the client in the 429 body. */
  message: string;
}

interface Window {
  count: number;
  resetAt: number;
}

/** Every limiter's store, so one timer can sweep expired windows. */
const stores = new Set<Map<string, Window>>();

setInterval(() => {
  const now = Date.now();
  for (const store of stores) {
    for (const [key, win] of store) {
      if (win.resetAt <= now) store.delete(key);
    }
  }
}, 60_000).unref();

export function rateLimit({ windowMs, max, message }: RateLimitOptions) {
  const store = new Map<string, Window>();
  stores.add(store);

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();

    let win = store.get(key);
    if (!win || win.resetAt <= now) {
      win = { count: 0, resetAt: now + windowMs };
      store.set(key, win);
    }
    win.count += 1;

    const resetSeconds = Math.ceil((win.resetAt - now) / 1000);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - win.count)));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (win.count > max) {
      res.setHeader("Retry-After", String(resetSeconds));
      res.status(429).json({ error: "Too Many Requests", message });
      return;
    }
    next();
  };
}

/** Whole-API flood guard — generous enough for fast feed scrolling. */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  message: "Too many requests — slow down and try again in a minute.",
});

/** Artwork downloads stream full museum masters, so they get a tight budget. */
export const downloadLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 30,
  message: "Download limit reached — try again in a few minutes.",
});

/** Artist-photo lookups each hit Wikidata upstream. */
export const artistPhotoLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: "Too many artist lookups — try again in a minute.",
});
