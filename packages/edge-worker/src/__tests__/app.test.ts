import { describe, expect, it, vi, beforeEach } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Module-level mocks                                                 */
/* ------------------------------------------------------------------ */

// vi.hoisted runs before vi.mock hoisting, so these are available in factories
const { mockMCPHandleRequest, mockApiAppFetch } = vi.hoisted(() => {
  return {
    mockMCPHandleRequest: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
    mockApiAppFetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [], totalFound: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  };
});

// Mock MCP handler — avoid bringing in heavy MCP SDK deps
vi.mock('../../src/mcp/handler.js', () => ({
  createMCPHandler: vi.fn().mockReturnValue({
    handleRequest: mockMCPHandleRequest,
  }),
}));

// Mock the api package — we test the real api app in its own package
vi.mock('@shopify-agent-channel/api', () => ({
  createApp: vi.fn().mockReturnValue({
    fetch: mockApiAppFetch,
  }),
}));

import { createEdgeApp } from '../app.js';
import { createMCPHandler } from '../mcp/handler.js';
import { createApp as createApiApp } from '@shopify-agent-channel/api';
import type { AgentsJson } from '@shopify-agent-channel/manifest';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const MOCK_SHOP = {
  id: 'shop-uuid-1',
  shopDomain: 'cool-kicks.myshopify.com',
  shopName: 'Cool Kicks',
  agentHostname: 'agent.coolkicks.com',
  agentEnabled: true,
  uninstalledAt: null,
  shopifyAccessTokenEncrypted: 'enc-token',
  shopifyScopes: 'read_products,write_checkouts',
  shopCurrency: 'USD',
  plan: 'starter',
  installedAt: new Date(),
  lastSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_AGENTS_JSON: AgentsJson = {
  name: 'Cool Kicks Agent Channel',
  version: '0.1.0',
  platform: 'shopify',
  issuer: 'shopify-agent-channel',
  base_url: 'https://cool-kicks.agent-channel.dev',
  interfaces: {
    mcp: { url: 'https://cool-kicks.agent-channel.dev/mcp', transport: 'sse' },
    http: { base_url: 'https://cool-kicks.agent-channel.dev/api' },
  },
  auth: {
    read: { mode: 'public' },
    write: { mode: 'bearer', description: 'Bearer token required', confirmation_note: 'checkout_url returned' },
  },
  capabilities: [
    {
      id: 'search_products', type: 'search', safety: 'low', requires_auth: false,
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      output_schema: { type: 'object' }, billing: { model: 'free' },
    },
    {
      id: 'get_product', type: 'read', safety: 'low', requires_auth: false,
      input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
      output_schema: { type: 'object' }, billing: { model: 'free' },
    },
    {
      id: 'create_cart', type: 'cart', safety: 'medium', requires_auth: true,
      input_schema: { type: 'object', properties: { lines: { type: 'array' } }, required: ['lines'] },
      output_schema: { type: 'object' }, billing: { model: 'free' },
    },
    {
      id: 'initiate_checkout', type: 'checkout', safety: 'high', requires_auth: true,
      input_schema: { type: 'object', properties: { cart_id: { type: 'string' } }, required: ['cart_id'] },
      output_schema: { type: 'object' }, billing: { model: 'free' },
    },
  ],
  store_info: { currency: 'USD', product_count: 50, last_synced: null },
  reliability: { nightly_reverify: true, success_score_url: 'https://cool-kicks.agent-channel.dev/api/success-score' },
};

const MOCK_MANIFEST = {
  id: 'manifest-1',
  shopId: 'shop-uuid-1',
  version: 1,
  capabilitiesJson: {},
  toolsJson: {},
  agentsJson: MOCK_AGENTS_JSON,
  generatedAt: new Date(),
  isActive: true,
};

function makeDb(shop = MOCK_SHOP, manifest = MOCK_MANIFEST) {
  return {
    query: {
      shops: {
        findFirst: vi.fn().mockImplementation((_opts?: any) => {
          // If the mock shop matches, return it; otherwise tests can override
          return Promise.resolve(shop);
        }),
      },
      manifests: {
        findFirst: vi.fn().mockResolvedValue(manifest),
      },
      successScores: { findMany: vi.fn().mockResolvedValue([]) },
      toolRuns: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

function makeRouter() {
  return {
    execute: vi.fn().mockResolvedValue({
      status: 'success',
      data: { results: [], totalFound: 0 },
      latencyMs: 5,
    }),
  };
}

function makeApp(
  dbOverride?: ReturnType<typeof makeDb>,
  routerOverride?: ReturnType<typeof makeRouter>,
) {
  const db = dbOverride ?? makeDb();
  const router = routerOverride ?? makeRouter();
  return {
    app: createEdgeApp({
      db: db as any,
      router: router as any,
      adminApiKey: 'admin-secret',
    }),
    db,
    router,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('Edge App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock api fetch for each test
    mockApiAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ results: [], totalFound: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  /* ---- 1. Welcome JSON ------------------------------------------- */

  it('GET / returns welcome JSON with shop info', async () => {
    const { app } = makeApp();
    const res = await app.request('/', {
      headers: { Host: 'agent.coolkicks.com' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.service).toBe('Shopify Agent Channel');
    expect(body.shop).toBe('Cool Kicks');
    expect(body.domain).toBe('cool-kicks.myshopify.com');
    expect(body.agents_json).toBe('/.well-known/agents.json');
    expect(body.mcp).toBe('/mcp');
    expect(body.api).toBe('/api');
    expect(body.docs).toBe('https://docs.shopify-agent-channel.dev');
  });

  /* ---- 2. Unknown shop 404 --------------------------------------- */

  it('returns 404 for unknown shop', async () => {
    const db = makeDb(null as any, null);
    // Override shops.findFirst to return null
    db.query.shops.findFirst.mockResolvedValue(null);
    const { app } = makeApp(db);
    const res = await app.request('/', {
      headers: { 'X-Shop-Domain': 'unknown-store.myshopify.com' },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe('Unknown shop endpoint');
  });

  /* ---- 3. Resolves by X-Shop-Domain ------------------------------ */

  it('resolves shop by X-Shop-Domain header', async () => {
    const { app } = makeApp();
    const res = await app.request('/', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.shop).toBe('Cool Kicks');
  });

  /* ---- 4. Resolves by /shop/:domain/ path prefix ----------------- */

  it('resolves shop by /shop/:domain/ path prefix', async () => {
    const { app } = makeApp();
    const res = await app.request('/shop/cool-kicks.myshopify.com/', {
      headers: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.shop).toBe('Cool Kicks');
  });

  /* ---- 5. Preserves querystring on path-prefix rewrite ----------- */

  it('preserves querystring on /shop/:domain/ rewrite', async () => {
    const router = makeRouter();
    router.execute.mockResolvedValue({
      status: 'success',
      data: { results: [{ id: 'p1', title: 'Jordan 1' }], totalFound: 1 },
      latencyMs: 5,
    });

    // Make api app fetch delegate to a mock that captures the request
    mockApiAppFetch.mockImplementation(async (req: Request) => {
      const url = new URL(req.url);
      // Return the query params in the response so we can verify
      return new Response(
        JSON.stringify({
          q: url.searchParams.get('q'),
          size: url.searchParams.get('size'),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const { app } = makeApp(undefined, router);
    const res = await app.request(
      '/shop/cool-kicks.myshopify.com/api/products/search?q=jordan&size=11',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.q).toBe('jordan');
    expect(body.size).toBe('11');
  });

  /* ---- 6. Does NOT expose internal shop ID in headers ------------ */

  it('does not expose internal shop ID in response headers', async () => {
    const { app } = makeApp();
    const res = await app.request('/', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });
    expect(res.headers.get('X-Resolved-Shop-Id')).toBeNull();
    expect(res.headers.get('X-Resolved-Shop-Domain')).toBeNull();
  });

  /* ---- 7. agents.json returns manifest with 4 capabilities ------- */

  it('GET /.well-known/agents.json returns manifest with 4 capabilities', async () => {
    // The api app mock should return the agents json
    mockApiAppFetch.mockImplementation(async () => {
      return new Response(JSON.stringify(MOCK_AGENTS_JSON), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { app } = makeApp();
    const res = await app.request('/.well-known/agents.json', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.capabilities).toHaveLength(4);
    expect(body.name).toBe('Cool Kicks Agent Channel');
  });

  /* ---- 8. Delegates /api/products/search to api app -------------- */

  it('delegates /api/products/search to api app', async () => {
    mockApiAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ results: [{ id: 'p1' }], totalFound: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { app } = makeApp();
    const res = await app.request('/api/products/search?q=sneakers', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.totalFound).toBe(1);
    // Verify createApp was called with the correct shopId
    expect(createApiApp).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-uuid-1' }),
    );
  });

  /* ---- 9. POST /api/cart without auth returns 401 ---------------- */

  it('POST /api/cart without auth returns 401', async () => {
    mockApiAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { app } = makeApp();
    const res = await app.request('/api/cart', {
      method: 'POST',
      headers: {
        'X-Shop-Domain': 'cool-kicks.myshopify.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ lines: [] }),
    });
    expect(res.status).toBe(401);
  });

  /* ---- 10. Rate limit 429 ---------------------------------------- */

  it('returns 429 when read limit exceeded', async () => {
    const { app } = makeApp();

    // Make 200 requests (the read limit)
    for (let i = 0; i < 200; i++) {
      await app.request('/', {
        headers: {
          'X-Shop-Domain': 'cool-kicks.myshopify.com',
          'CF-Connecting-IP': '1.2.3.4',
        },
      });
    }

    // 201st request should be rate limited
    const res = await app.request('/', {
      headers: {
        'X-Shop-Domain': 'cool-kicks.myshopify.com',
        'CF-Connecting-IP': '1.2.3.4',
      },
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error).toBe('Too many requests');
    expect(body.retryAfter).toBeGreaterThan(0);
  });
});
