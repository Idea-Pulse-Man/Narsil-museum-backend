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

  app.get("/", (_req, res) => {
    res.json({
      name: "narsil-museum-backend",
      version: "1.0.0",
      source: "Art Institute of Chicago Public API",
      images: `IIIF Image API 3.0 (${env.iiif.baseUrl}) · delivery=${env.imageDelivery}`,
      endpoints: [
        "GET /api/health",
        "GET /api/artworks",
        "GET /api/artworks/:id",
        "GET /api/artists",
        "GET /api/artists/:id",
        "GET /api/image/:identifier",
        "POST /api/refresh",
      ],
    });
  });

  app.use("/api", apiRoutes(catalog));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
