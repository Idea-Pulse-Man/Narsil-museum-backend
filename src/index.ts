/**
 * Local development / `npm start` bootstrap.
 * Vercel uses `src/app.ts`'s default export instead (zero-config Express entry).
 */
import { fileURLToPath } from "node:url";
import { env } from "./config/env.js";
import app from "./app.js";

async function start(): Promise<void> {
  const server = app.listen(env.port, () => {
    console.log(`narsil-museum-backend listening on http://localhost:${env.port}`);
    console.log(`  source : ${env.museum.source} → ${env.museum.apiBaseUrl}`);
    console.log(
      `  images : IIIF Image API 3.0 → ${env.iiif.baseUrl} (delivery=${env.imageDelivery})`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received — shutting down.`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const isDirectRun =
  !process.env.VERCEL &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  start().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
