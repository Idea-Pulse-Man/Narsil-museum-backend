/**
 * Application entry point.
 *
 * - Vercel: imports this module and uses the default-exported Express app.
 * - Local dev / `npm start`: runs the bootstrap block at the bottom.
 */
import { fileURLToPath } from "node:url";
import { env } from "./config/env.js";
import { CatalogService } from "./museum/catalog.js";
import { createApp } from "./app.js";

const catalog = new CatalogService(env);
const app = createApp(catalog);

export default app;

async function start(): Promise<void> {
  const server = app.listen(env.port, () => {
    console.log(`narsil-museum-backend listening on http://localhost:${env.port}`);
    console.log(`  source : ${env.museum.source} → ${env.museum.apiBaseUrl}`);
    console.log(
      `  images : IIIF Image API 3.0 → ${env.iiif.baseUrl} (delivery=${env.imageDelivery})`,
    );
  });

  catalog
    .warm()
    .then(({ artworks, artists }) =>
      console.log(`  catalog: warmed ${artworks} artworks, ${artists} artists`),
    )
    .catch((err) =>
      console.warn(
        `  catalog: warm failed (will retry on first request): ${
          err instanceof Error ? err.message : err
        }`,
      ),
    );

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received — shutting down.`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Warm the catalog in the background on cold starts (Vercel + local).
catalog.warm().catch(() => {});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
