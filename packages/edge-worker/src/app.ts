import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { manifests } from '@shopify-agent-channel/db';
import type { Database } from '@shopify-agent-channel/db';
import type { ExecutionRouter } from '@shopify-agent-channel/exec';
import { createApp } from '@shopify-agent-channel/api';
import { resolveShop } from './middleware/shopResolver.js';
import {
  RateLimiter,
  getRateLimitKey,
  TIER_LIMITS,
  type RateLimitTier,
} from './middleware/rateLimiter.js';
import { createMCPHandler } from './mcp/handler.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface EdgeAppConfig {
  db: Database;
  router: ExecutionRouter;
  adminApiKey?: string;
}

/* ------------------------------------------------------------------ */
/*  Hono variable typing                                               */
/* ------------------------------------------------------------------ */

type Variables = {
  pathDomain: string | undefined;
  rewrittenUrl: string | undefined;
  shop: { id: string; shopDomain: string; shopName: string | null; agentHostname: string | null; agentEnabled: boolean | null; uninstalledAt: Date | null };
  shopId: string;
  shopDomain: string;
  shopName: string;
};

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createEdgeApp(config: EdgeAppConfig): Hono<{ Variables: Variables }> {
  const { db, router, adminApiKey } = config;
  const rateLimiter = new RateLimiter();

  const app = new Hono<{ Variables: Variables }>();

  /* ---------------------------------------------------------------- */
  /* 1. Path-prefix rewrite middleware: /shop/:domain/*                */
  /* ---------------------------------------------------------------- */

  app.use('/shop/:domain/*', async (c, next) => {
    const domain = c.req.param('domain');
    c.set('pathDomain', domain);

    // Build rewritten URL: strip /shop/:domain prefix, preserve query
    const url = new URL(c.req.url);
    const prefix = `/shop/${domain}`;
    const remaining = url.pathname.slice(prefix.length) || '/';
    url.pathname = remaining;
    c.set('rewrittenUrl', url.toString());

    await next();
  });

  /* ---------------------------------------------------------------- */
  /* 2. Shop resolution middleware                                     */
  /* ---------------------------------------------------------------- */

  app.use('*', async (c, next) => {
    const host = c.req.header('Host') ?? undefined;
    const xShopDomain = c.req.header('X-Shop-Domain') ?? undefined;
    const pathDomain = c.get('pathDomain') ?? undefined;

    const result = await resolveShop({ host, xShopDomain, pathDomain }, db);

    if (!result.shop) {
      return c.json({ error: 'Unknown shop endpoint' }, 404);
    }

    const shop = result.shop;
    c.set('shop', shop);
    c.set('shopId', shop.id);
    c.set('shopDomain', shop.shopDomain);
    c.set('shopName', shop.shopName ?? '');

    // Set response headers
    c.header('X-Resolved-Shop-Id', shop.id);
    c.header('X-Resolved-Shop-Domain', shop.shopDomain);

    await next();
  });

  /* ---------------------------------------------------------------- */
  /* 3. Rate limiting middleware                                        */
  /* ---------------------------------------------------------------- */

  app.use('*', async (c, next) => {
    // Determine client IP
    const cfIp = c.req.header('CF-Connecting-IP');
    const xForwardedFor = c.req.header('X-Forwarded-For');
    const ip = cfIp ?? xForwardedFor?.split(',')[0]?.trim() ?? 'unknown';

    const authHeader = c.req.header('Authorization') ?? undefined;
    const pathname = new URL(c.req.url).pathname;
    const method = c.req.method;

    // Determine tier
    let tier: RateLimitTier = 'read';
    if (pathname.startsWith('/admin/') || pathname.startsWith('/internal/')) {
      tier = 'admin';
    } else if (method === 'POST' && pathname.startsWith('/api/cart')) {
      tier = 'write';
    }

    const key = getRateLimitKey(tier, ip, authHeader);
    const result = rateLimiter.check(key, TIER_LIMITS[tier]);

    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfter));
      return c.json({ error: 'Too many requests', retryAfter: result.retryAfter }, 429);
    }

    c.header('X-RateLimit-Remaining', String(result.remaining));
    await next();
  });

  /* ---------------------------------------------------------------- */
  /* 4. Routes                                                         */
  /* ---------------------------------------------------------------- */

  // GET / — Welcome JSON
  app.get('/', (c) => {
    return c.json({
      service: 'Shopify Agent Channel',
      shop: c.get('shopName'),
      domain: c.get('shopDomain'),
      agents_json: '/.well-known/agents.json',
      mcp: '/mcp',
      api: '/api',
      docs: 'https://docs.shopify-agent-channel.dev',
    });
  });

  // Catch-all for everything else
  app.all('*', async (c) => {
    const shopId = c.get('shopId');
    const rewrittenUrl = c.get('rewrittenUrl');

    // Determine effective pathname (rewritten for path-prefix mode)
    const effectivePath = rewrittenUrl
      ? new URL(rewrittenUrl).pathname
      : new URL(c.req.url).pathname;

    // Welcome JSON for path-prefix mode (GET /shop/:domain/)
    if (effectivePath === '/' && c.req.method === 'GET') {
      return c.json({
        service: 'Shopify Agent Channel',
        shop: c.get('shopName'),
        domain: c.get('shopDomain'),
        agents_json: '/.well-known/agents.json',
        mcp: '/mcp',
        api: '/api',
        docs: 'https://docs.shopify-agent-channel.dev',
      });
    }

    // Auth and webhook routes bypass manifest requirement —
    // a freshly installed shop won't have a manifest yet.
    const needsManifest = !(
      effectivePath.startsWith('/auth/') ||
      effectivePath.startsWith('/webhooks/')
    );

    // Load active manifest (when needed)
    let agentsJson: any = null;
    if (needsManifest) {
      const manifest = await db.query.manifests.findFirst({
        where: and(eq(manifests.shopId, shopId), eq(manifests.isActive, true)),
      });

      if (!manifest) {
        return c.json({ error: 'No active manifest for this shop' }, 404);
      }

      agentsJson = manifest.agentsJson;
    }

    // Serve agents.json directly (avoid double-loading in api app)
    if (effectivePath === '/.well-known/agents.json' && agentsJson) {
      return c.json(agentsJson);
    }

    // MCP handler
    if (effectivePath === '/mcp' || effectivePath.startsWith('/mcp/')) {
      const handler = createMCPHandler({ shopId, db, router });
      return handler.handleRequest(c.req.raw);
    }

    // Delegate to api app
    const apiApp = createApp({
      shopId,
      db,
      router,
      agentsJson,
      adminApiKey,
    });

    if (rewrittenUrl) {
      // Path-prefix mode — create a new request with rewritten URL
      const newRequest = new Request(rewrittenUrl, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.raw.body,
        // @ts-expect-error duplex needed for streaming body
        duplex: 'half',
      });
      return apiApp.fetch(newRequest);
    }

    return apiApp.fetch(c.req.raw);
  });

  return app;
}
