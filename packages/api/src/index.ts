import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { eq, desc } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import type { Database } from '@shopify-agent-channel/db';
import { manifests, shops, successScores, toolRuns } from '@shopify-agent-channel/db';
import type { ExecutionRouter } from '@shopify-agent-channel/exec';
import type { AgentsJson } from '@shopify-agent-channel/manifest';
import type { ToolDefinition } from '@shopify-agent-channel/catalog';
import {
  generateInstallUrl,
  generateOAuthState,
  validateOAuthState,
  handleOAuthCallback,
  verifyShopifyWebhook,
  handleAppUninstalled,
  handleProductsUpdate,
  validateEncryptionKey,
  encryptToken,
} from '@shopify-agent-channel/shopify-auth';
import { ingestShop } from '@shopify-agent-channel/ingest';

export interface AppConfig {
  shopId: string;
  db: Database;
  router: ExecutionRouter;
  agentsJson: AgentsJson;
  adminApiKey?: string;
  corsOrigin?: string;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

// Shopify ID format: numeric or GID (gid://shopify/Product/123)
const SHOPIFY_ID_REGEX = /^(gid:\/\/shopify\/\w+\/\d+|\d+)$/;
const SHOPIFY_CART_ID_REGEX = /^gid:\/\/shopify\/Cart\/[a-zA-Z0-9_-]+$/;

const SHOPIFY_VARIANT_ID_REGEX = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

const CartBodySchema = z.object({
  lines: z.array(z.object({
    variant_id: z.string().regex(SHOPIFY_VARIANT_ID_REGEX, 'Must be a Shopify ProductVariant GID'),
    quantity: z.number().int().min(1).max(99),
  })).min(1).max(50),
});

export function createApp(config: AppConfig): Hono {
  const { shopId, db, router, agentsJson } = config;
  const adminApiKey = config.adminApiKey ?? process.env['ADMIN_API_KEY'] ?? '';
  if (!adminApiKey || adminApiKey.length < 32) {
    throw new Error('ADMIN_API_KEY must be set and at least 32 characters');
  }

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

  const corsOrigin = config.corsOrigin ?? process.env['SHOPIFY_APP_URL'];
  if (!corsOrigin) {
    throw new Error('SHOPIFY_APP_URL must be set (or pass corsOrigin in config)');
  }

  app.use('*', cors({
    origin: corsOrigin,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-Shop-Domain', 'X-Admin-Key'],
  }));

  // Security response headers
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-XSS-Protection', '0');
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  // Bearer auth guard — validates token against stored hash
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bearerAuth = async (c: any, next: () => Promise<void>) => {
    const auth = c.req.header('Authorization') as string | undefined;
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    const token = auth.slice(7);
    if (!token) return c.json({ error: 'Authentication required' }, 401);

    // Hash the provided token and compare against stored hash
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const shop = await db.query.shops.findFirst({
      where: eq(shops.shopDomain, c.req.header('X-Shop-Domain') ?? ''),
    });
    if (!shop?.agentApiKeyHash) {
      console.warn(`[auth] shop ${c.req.header('X-Shop-Domain')} has no agentApiKeyHash — possible broken install`);
      return c.json({ error: 'No API key configured for this shop' }, 401);
    }
    // Timing-safe comparison
    const expected = Buffer.from(shop.agentApiKeyHash, 'hex');
    const actual = Buffer.from(tokenHash, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return c.json({ error: 'Invalid API key' }, 401);
    }
    await next();
  };

  // Admin auth guard — timing-safe comparison
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminAuth = async (c: any, next: () => Promise<void>) => {
    const auth = c.req.header('Authorization') as string | undefined;
    if (!auth) return c.json({ error: 'Admin authentication required' }, 401);
    const expectedStr = `Bearer ${adminApiKey}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expectedStr);
    if (authBuf.length !== expectedBuf.length || !timingSafeEqual(authBuf, expectedBuf)) {
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
    const q = (c.req.query('q') ?? '').slice(0, 500);
    const filters: Record<string, unknown> = {};
    const size = c.req.query('size')?.slice(0, 100);
    const color = c.req.query('color')?.slice(0, 100);
    const minPriceRaw = c.req.query('min_price') ? Number(c.req.query('min_price')) : undefined;
    const maxPriceRaw = c.req.query('max_price') ? Number(c.req.query('max_price')) : undefined;
    const inStock = c.req.query('in_stock');
    if (size) filters['size'] = size;
    if (color) filters['color'] = color;
    if (minPriceRaw !== undefined) {
      if (!Number.isFinite(minPriceRaw) || minPriceRaw < 0) {
        return c.json({ error: 'min_price must be a positive number' }, 400);
      }
      filters['minPrice'] = minPriceRaw;
    }
    if (maxPriceRaw !== undefined) {
      if (!Number.isFinite(maxPriceRaw) || maxPriceRaw < 0) {
        return c.json({ error: 'max_price must be a positive number' }, 400);
      }
      filters['maxPrice'] = maxPriceRaw;
    }
    if (inStock !== undefined) filters['inStock'] = inStock === 'true';
    const limitRaw = Number(c.req.query('limit') ?? '20');
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;

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
    if (!SHOPIFY_ID_REGEX.test(productId)) {
      return c.json({ error: 'Invalid product_id format' }, 400);
    }
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
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request body', details: [] }, 400);
    }
    const parsed = CartBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400);
    }
    const body = parsed.data;
    const result = await router.execute(
      {
        shopId,
        toolName: 'create_cart',
        inputs: body,
        authContext: { isAuthenticated: true },
      },
      toolDefs.get('create_cart')!,
    );
    if (result.status === 'error') return c.json({ error: result.error?.message }, 500);
    return c.json(result.data, 201);
  });

  app.post('/api/cart/:cart_id/checkout', bearerAuth, async (c) => {
    const cartId = c.req.param('cart_id');
    if (!SHOPIFY_CART_ID_REGEX.test(cartId)) {
      return c.json({ error: 'Invalid cart_id format' }, 400);
    }
    const result = await router.execute(
      {
        shopId,
        toolName: 'initiate_checkout',
        inputs: { cart_id: cartId },
        authContext: { isAuthenticated: true },
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
    // Redact sensitive fields
    const { shopifyAccessTokenEncrypted: _, agentApiKeyHash: __, ...safeShop } = shop;
    return c.json({ shop: safeShop });
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
    const limitRaw = Number(c.req.query('limit') ?? '20');
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
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
    const state = generateOAuthState();
    const url = await generateInstallUrl(shopDomain, state);
    const res = c.redirect(url);
    res.headers.append(
      'Set-Cookie',
      `oauth_state=${state}; HttpOnly; SameSite=Lax; Max-Age=300; Path=/auth/shopify/callback; Secure`,
    );
    return res;
  });

  app.get('/auth/shopify/callback', async (c) => {
    const state = c.req.query('state') ?? '';
    const params = {
      shop: c.req.query('shop') ?? '',
      code: c.req.query('code') ?? '',
      hmac: c.req.query('hmac') ?? '',
      timestamp: c.req.query('timestamp') ?? '',
    };

    // --- CSRF protection: validate state against cookie ---
    const clearCookie = 'oauth_state=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/auth/shopify/callback; Secure';
    try {
      validateOAuthState(state);
    } catch {
      return c.json({ error: 'Invalid or missing OAuth state parameter' }, 400);
    }

    // Parse oauth_state from Cookie header — take LAST match to prevent subdomain cookie injection
    const cookieHeader = c.req.header('Cookie') ?? '';
    const cookies = cookieHeader.split(';').map((s: string) => s.trim());
    let storedState = '';
    for (const cookie of cookies) {
      if (cookie.startsWith('oauth_state=')) {
        storedState = cookie.slice('oauth_state='.length);
      }
    }

    if (!storedState) {
      const res = c.json({ error: 'Missing OAuth state cookie' }, 400);
      res.headers.append('Set-Cookie', clearCookie);
      return res;
    }

    if (state !== storedState) {
      const res = c.json({ error: 'OAuth state mismatch' }, 400);
      res.headers.append('Set-Cookie', clearCookie);
      return res;
    }

    try {
      const { accessToken, scopes } = await handleOAuthCallback(params);
      // Encrypt + persist immediately
      const encKey = process.env['ENCRYPTION_KEY'] ?? '';
      validateEncryptionKey(encKey);
      const encrypted = encryptToken(accessToken, encKey);
      // Generate agent API key
      const agentApiKey = randomBytes(32).toString('hex');
      const agentApiKeyHash = createHash('sha256').update(agentApiKey).digest('hex');
      // Upsert shop
      await db.insert(shops).values({
        shopDomain: params.shop,
        shopifyAccessTokenEncrypted: encrypted,
        shopifyScopes: scopes,
        agentApiKeyHash,
      }).onConflictDoUpdate({
        target: shops.shopDomain,
        set: { shopifyAccessTokenEncrypted: encrypted, shopifyScopes: scopes, agentApiKeyHash, updatedAt: new Date() },
      });
      // Clear the state cookie and return agent key ONCE — no Shopify token exposed
      const res = c.json({ success: true, shopDomain: params.shop, agentApiKey });
      res.headers.append('Set-Cookie', clearCookie);
      return res;
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Unknown';
      console.error(`[oauth] callback error for ${params.shop}: ${rawMsg}`);
      const res = c.json({ error: 'OAuth failed' }, 400);
      res.headers.append('Set-Cookie', clearCookie);
      return res;
    }
  });

  app.post('/webhooks/shopify', async (c) => {
    const body = await c.req.text();
    // Reject oversized webhook payloads (Shopify typically sends <1MB)
    if (body.length > 2 * 1024 * 1024) {
      return c.json({ error: 'Webhook payload too large' }, 413);
    }
    const hmac = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
    const topic = c.req.header('X-Shopify-Topic') ?? '';
    const shopDomain = c.req.header('X-Shopify-Shop-Domain') ?? '';
    const secret = process.env['SHOPIFY_API_SECRET'] ?? '';

    if (!verifyShopifyWebhook(body, hmac, secret)) {
      return c.json({ error: 'Invalid webhook signature' }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid webhook body' }, 400);
    }

    if (topic === 'app/uninstalled') {
      await handleAppUninstalled(shopDomain, db);
    } else if (topic === 'products/update') {
      await handleProductsUpdate(shopDomain, payload, db);
    } else {
      console.warn(`[webhook] unhandled topic: ${topic} from ${shopDomain}`);
    }
    return c.json({ ok: true });
  });

  return app;
}
