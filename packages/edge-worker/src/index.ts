import { getDb } from '@shopify-agent-channel/db';
import { ExecutionRouter, ShopifyAdapter } from '@shopify-agent-channel/exec';
import { createEdgeApp } from './app.js';

export interface Env {
  DATABASE_URL: string;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  ENCRYPTION_KEY: string;
  ADMIN_API_KEY: string;
  ENVIRONMENT: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = getDb(env.DATABASE_URL);
    const adapter = new ShopifyAdapter(db);
    const router = new ExecutionRouter(adapter, db);

    const app = createEdgeApp({
      db,
      router,
      adminApiKey: env.ADMIN_API_KEY,
    });

    return app.fetch(request);
  },
};

export { createEdgeApp } from './app.js';
export type { EdgeAppConfig } from './app.js';
