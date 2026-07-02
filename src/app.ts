import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { CatalogService } from "./museum/catalog.js";
import { apiRoutes } from "./routes/index.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

/**
 * Build the Express application. Exported separately from the server bootstrap
 * so it can be imported in tests without binding a port.
 */
export function createApp(catalog: CatalogService = new CatalogService(env)): Express {
  const app = express();

  app.use(
    cors({
      origin: env.corsOrigin,
      methods: ["GET", "POST"],
    }),
  );
  app.use(express.json());

  // Local dev: serve public/index.html from project root.
  // On Vercel, files in public/ are served from the CDN (express.static is ignored).
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
  app.use(express.static(publicDir));

  app.use("/api", apiRoutes(catalog));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
