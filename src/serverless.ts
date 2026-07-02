/**
 * Vercel serverless entry — exports the Express app (no listen()).
 */
import { env } from "./config/env.js";
import { CatalogService } from "./museum/catalog.js";
import { createApp } from "./app.js";

const catalog = new CatalogService(env);
const app = createApp(catalog);

catalog.warm().catch(() => {});

export default app;
