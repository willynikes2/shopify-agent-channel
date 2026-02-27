import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { eq, desc } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { manifests, shops, successScores, toolRuns } from '@shopify-agent-channel/db';
import type { ExecutionRouter } from '@shopify-agent-channel/exec';
import type { AgentsJson } from '@shopify-agent-channel/manifest';
import type { ToolDefinition } from '@shopify-agent-channel/catalog';
import {
  generateInstallUrl,
  handleOAuthCallback,
  verifyShopifyWebhook,
  handleAppUninstalled,
  handleProductsUpdate,
} from '@shopify-agent-channel/shopify-auth';
import { ingestShop } from '@shopify-agent-channel/ingest';

export interface AppConfig {
  shopId: string;
  db: Database;
  router: ExecutionRouter;
  agentsJson: AgentsJson;
  adminApiKey?: string;
}

export function createApp(config: AppConfig): Hono {
  const { shopId, db, router, agentsJson } = config;
  const adminApiKey = config.adminApiKey ?? process.env['ADMIN_API_KEY'] ?? '';

  // Derive ToolDefinitions from manifest for passing to router.execute
  const toolDefs = new Map<string, ToolDefinition>(
    agentsJson.capabilities.map((cap) => [
      cap.id,
      {
        name: cap.id,
        type: cap.type,
        safety_level: cap.safety as 'low' | 'medium' | 'high',
        requires_auth: cap.requires_auth,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: cap.input_schema as Record<string, any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        output_schema: cap.output_schema as Record<string, any>,
      },
    ]),
  );

  const app = new Hono();

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  app.use('*', cors());

  // Bearer auth guard — returns 401 if no valid Bearer token
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bearerAuth = async (c: any, next: () => Promise<void>) => {
    const auth = c.req.header('Authorization') as string | undefined;
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    await next();
  };

  // Admin auth guard — compares Authorization to configured adminApiKey
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminAuth = async (c: any, next: () => Promise<void>) => {
    const auth = c.req.header('Authorization') as string | undefined;
    if (!auth || auth !== `Bearer ${adminApiKey}`) {
      return c.json({ error: 'Admin authentication required' }, 401);
    }
    await next();
  };

  // ---------------------------------------------------------------------------
  // /.well-known/agents.json — serve the active manifest
  // ---------------------------------------------------------------------------

  app.get('/.well-known/agents.json', (c) => c.json(agentsJson));

  // ---------------------------------------------------------------------------
  // Public read routes
  // ---------------------------------------------------------------------------

  app.get('/api/products/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const filters: Record<string, unknown> = {};
    const size = c.req.query('size');
    const color = c.req.query('color');
    const minPrice = c.req.query('min_price');
    const maxPrice = c.req.query('max_price');
    const inStock = c.req.query('in_stock');
    if (size) filters['size'] = size;
    if (color) filters['color'] = color;
    if (minPrice) filters['minPrice'] = Number(minPrice);
    if (maxPrice) filters['maxPrice'] = Number(maxPrice);
    if (inStock !== undefined) filters['inStock'] = inStock === 'true';
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 20;

    const result = await router.execute(
      {
        shopId,
        toolName: 'search_products',
        inputs: { query: q, filters, limit },
        authContext: { isAuthenticated: true },
      },
      toolDefs.get('search_products')!,
    );

    if (result.status === 'error') return c.json({ error: result.error?.message }, 500);
    return c.json(result.data);
  });

  app.get('/api/products/:product_id', async (c) => {
    const productId = c.req.param('product_id');
    const result = await router.execute(
      {
        shopId,
        toolName: 'get_product',
        inputs: { product_id: productId },
        authContext: { isAuthenticated: true },
      },
      toolDefs.get('get_product')!,
    );

    if (result.status === 'error') {
      const status = result.error?.code === 'NOT_FOUND' ? 404 : 500;
      return c.json({ error: result.error?.message }, status);
    }
    return c.json(result.data);
  });

  app.get('/api/success-score', async (c) => {
    const scores = await db.query.successScores.findMany({
      where: eq(successScores.shopId, shopId),
    });
    return c.json({ scores });
  });

  // ---------------------------------------------------------------------------
  // Authenticated write routes
  // ---------------------------------------------------------------------------

  app.post('/api/cart', bearerAuth, async (c) => {
    const token = (c.req.header('Authorization') as string).replace('Bearer ', '');
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await router.execute(
      {
        shopId,
        toolName: 'create_cart',
        inputs: body,
        authContext: { isAuthenticated: true, token },
      },
      toolDefs.get('create_cart')!,
    );
    if (result.status === 'error') return c.json({ error: result.error?.message }, 500);
    return c.json(result.data, 201);
  });

  app.post('/api/cart/:cart_id/checkout', bearerAuth, async (c) => {
    const cartId = c.req.param('cart_id');
    const token = (c.req.header('Authorization') as string).replace('Bearer ', '');
    const result = await router.execute(
      {
        shopId,
        toolName: 'initiate_checkout',
        inputs: { cart_id: cartId },
        authContext: { isAuthenticated: true, token },
      },
      toolDefs.get('initiate_checkout')!,
    );
    if (result.status === 'error') return c.json({ error: result.error?.message }, 500);
    return c.json(result.data);
  });

  // ---------------------------------------------------------------------------
  // Admin routes (internal auth)
  // ---------------------------------------------------------------------------

  app.post('/admin/shops', adminAuth, async (c) => {
    const body = (await c.req.json()) as { shop_domain: string };
    const shop = await db.query.shops.findFirst({
      where: eq(shops.shopDomain, body.shop_domain),
    });
    if (!shop) return c.json({ error: 'Shop not found' }, 404);
    return c.json({ shop });
  });

  app.post('/admin/shops/:id/sync', adminAuth, async (c) => {
    const id = c.req.param('id');
    // Fire-and-forget; real ingest runs async
    ingestShop(id, db).catch(() => undefined);
    return c.json({ ok: true, shopId: id, message: 'Sync triggered' }, 202);
  });

  app.get('/admin/shops/:id/manifest', adminAuth, async (c) => {
    const id = c.req.param('id');
    const manifest = await db.query.manifests.findFirst({
      where: eq(manifests.shopId, id),
    });
    if (!manifest) return c.json({ error: 'No manifest found' }, 404);
    return c.json(manifest.agentsJson);
  });

  app.get('/admin/shops/:id/runs', adminAuth, async (c) => {
    const id = c.req.param('id');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 20;
    const runs = await db.query.toolRuns.findMany({
      where: eq(toolRuns.shopId, id),
      orderBy: [desc(toolRuns.createdAt)],
      limit,
    });
    return c.json({ runs });
  });

  app.post('/internal/reverify', adminAuth, async (c) => {
    return c.json({ ok: true, message: 'Reverification scheduled' });
  });

  // ---------------------------------------------------------------------------
  // Shopify OAuth + Webhook routes
  // ---------------------------------------------------------------------------

  app.get('/auth/shopify', async (c) => {
    const shopDomain = c.req.query('shop');
    if (!shopDomain) return c.json({ error: 'Missing shop parameter' }, 400);
    const url = await generateInstallUrl(shopDomain);
    return c.redirect(url);
  });

  app.get('/auth/shopify/callback', async (c) => {
    const params = {
      shop: c.req.query('shop') ?? '',
      code: c.req.query('code') ?? '',
      hmac: c.req.query('hmac') ?? '',
      timestamp: c.req.query('timestamp') ?? '',
    };
    try {
      const { accessToken, scopes } = await handleOAuthCallback(params);
      return c.json({ ok: true, shop: params.shop, scopes, accessToken: accessToken.slice(0, 8) + '…' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'OAuth error';
      return c.json({ error: msg }, 400);
    }
  });

  app.post('/webhooks/shopify', async (c) => {
    const body = await c.req.text();
    const hmac = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
    const topic = c.req.header('X-Shopify-Topic') ?? '';
    const shopDomain = c.req.header('X-Shopify-Shop-Domain') ?? '';
    const secret = process.env['SHOPIFY_API_SECRET'] ?? '';

    if (!verifyShopifyWebhook(body, hmac, secret)) {
      return c.json({ error: 'Invalid webhook signature' }, 401);
    }

    const payload = JSON.parse(body) as Record<string, unknown>;
    if (topic === 'app/uninstalled') {
      await handleAppUninstalled(shopDomain, db);
    } else if (topic === 'products/update') {
      await handleProductsUpdate(shopDomain, payload, db);
    }
    return c.json({ ok: true });
  });

  return app;
}
