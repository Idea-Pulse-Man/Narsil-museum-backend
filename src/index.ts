/**
 * Local development / `npm start` bootstrap.
 * Vercel uses `src/app.ts`'s default export instead (zero-config Express entry).
 */
import { env } from "./config/env.js";
import app from "./app.js";

async function start(): Promise<void> {
  const server = app.listen(env.port, () => {
    console.log(`narsil-museum-backend listening on http://localhost:${env.port}`);
    console.log(`  catalog: Supabase (ingested from ${env.museum.sources.join(", ")})`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received — shutting down.`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});