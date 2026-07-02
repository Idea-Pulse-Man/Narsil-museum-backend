/**
 * Server bootstrap. Creates the app, warms the catalog cache from the museum
 * Public API, and starts listening.
 */
import { env } from "./config/env.js";
import { CatalogService } from "./museum/catalog.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const catalog = new CatalogService(env);
  const app = createApp(catalog);

  const server = app.listen(env.port, () => {
    console.log(`narsil-museum-backend listening on http://localhost:${env.port}`);
    console.log(`  source : ${env.museum.source} → ${env.museum.apiBaseUrl}`);
    console.log(`  images : IIIF Image API 3.0 → ${env.iiif.baseUrl} (delivery=${env.imageDelivery})`);
  });

  // Warm the cache in the background so the first client request is instant.
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

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
