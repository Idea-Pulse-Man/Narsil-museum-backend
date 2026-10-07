import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { CatalogService } from "./museum/catalog.js";
import { apiRoutes } from "./routes/index.js";
import { stripeWebhookHandler } from "./routes/stripeWebhook.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { shareRoutes } from "./routes/share.js";

/**
 * Decide whether a request's Origin is allowed. Requests with no Origin header
 * (curl, same-origin, server-to-server) are always allowed. Otherwise the origin
 * must be in the allow-list — the app's own origins plus CORS_ORIGIN (see
 * config/env.ts). Arbitrary *.vercel.app sites are deliberately not trusted:
 * anyone can deploy one.
 */
function isAllowedOrigin(origin: string): boolean {
  if (env.corsOrigin === "*") return true;
  return env.corsOrigin.includes(origin);
}

/**
 * Build the Express application. Exported separately from the server bootstrap
 * so it can be imported in tests without binding a port.
 */
export function createApp(catalog: CatalogService = new CatalogService(env)): Express {
  const app = express();
  // Behind CloudFront: resolve req.ip to the viewer, not the edge node.
  app.set("trust proxy", env.trustProxy);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || isAllowedOrigin(origin)) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      methods: ["GET", "POST"],
    }),
  );
  // Stripe webhook needs the RAW body for signature verification, so it is
  // mounted before express.json() consumes the stream.
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    stripeWebhookHandler(catalog),
  );

  app.use(express.json());

  // Local dev: serve public/index.html from project root.
  // On Vercel, files in public/ are served from the CDN (express.static is ignored).
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
  app.use(express.static(publicDir));

  app.use("/api", apiLimiter, apiRoutes(catalog));
  // Shared artwork links + Universal Links file (outside /api: these URLs
  // are what people see and tap).
  app.use("/share", apiLimiter);
  app.use(shareRoutes());

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

/**
 * Vercel zero-config Express entry — the default export below is what the
 * platform detects and deploys as a single function. Warming the catalog
 * here (rather than in a listener) means the first real request is fast.
 */
const catalog = new CatalogService(env);
const app = createApp(catalog);
catalog.warm().catch(() => {});

export const config = {
  maxDuration: 30,
};

export default app;
