/**
 * Vercel / production entry — exports the Express app only (no listen()).
 */
import { env } from "./config/env.js";
import { CatalogService } from "./museum/catalog.js";
import { createApp } from "./app.js";

const catalog = new CatalogService(env);
const app = createApp(catalog);

catalog.warm().catch(() => {});

export const config = {
  maxDuration: 30,
  memory: 1024,
};

export default app;
