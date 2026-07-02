/**
 * Vercel serverless entry point.
 *
 * Vercel only compiles files under a root-level `api/` directory into
 * functions, so this file lives here (not under `src/`) and re-exports the
 * Express app built by `src/app.ts`. `vercel.json` rewrites every request to
 * `/api/index`, which resolves to this function.
 */
import { env } from "../src/config/env.js";
import { CatalogService } from "../src/museum/catalog.js";
import { createApp } from "../src/app.js";

const catalog = new CatalogService(env);
const app = createApp(catalog);

catalog.warm().catch(() => {});

export const config = {
  maxDuration: 30,
};

export default app;
