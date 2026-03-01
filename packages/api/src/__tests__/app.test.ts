import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { createApp } from '../index.js';
import type { AgentsJson } from '@shopify-agent-channel/manifest';

// Set env before any createApp calls
process.env['SHOPIFY_APP_URL'] = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP_ID = 'shop-uuid-1';
const ADMIN_KEY = 'a]b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'; // 32 chars
const TEST_TOKEN = 'tok_abc_test_token_1234567890abcdef';
const TEST_TOKEN_HASH = createHash('sha256').update(TEST_TOKEN).digest('hex');

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

function makeRouter(result = { status: 'success' as const, data: { results: [], totalFound: 0 } as unknown, latencyMs: 5 }) {
  return { execute: vi.fn().mockResolvedValue(result) };
}

function makeDb() {
  return {
    query: {
      successScores: { findMany: vi.fn().mockResolvedValue([]) },
      shops: { findFirst: vi.fn().mockResolvedValue({ agentApiKeyHash: TEST_TOKEN_HASH }) },
      manifests: { findFirst: vi.fn().mockResolvedValue(null) },
      toolRuns: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

function makeApp(routerResult?: { status: 'success'; data: unknown; latencyMs: number }) {
  return createApp({
    shopId: SHOP_ID,
    db: makeDb() as any,
    router: makeRouter(routerResult) as any,
    agentsJson: MOCK_AGENTS_JSON,
    adminApiKey: ADMIN_KEY,
    corsOrigin: 'http://localhost:3000',
  });
}

// ---------------------------------------------------------------------------
// GET /.well-known/agents.json  (BUILDSHEET required)
// ---------------------------------------------------------------------------

describe('GET /.well-known/agents.json', () => {
  it('returns 200 with the manifest', async () => {
    const app = makeApp();
    const res = await app.request('/.well-known/agents.json');
    expect(res.status).toBe(200);
  });

  it('returns manifest with correct name and capabilities', async () => {
    const app = makeApp();
    const res = await app.request('/.well-known/agents.json');
    const body = await res.json() as any;
    expect(body.name).toBe('Cool Kicks Agent Channel');
    expect(body.capabilities).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// GET /api/products/search  (BUILDSHEET required)
// ---------------------------------------------------------------------------

describe('GET /api/products/search', () => {
  it('returns 200 with results', async () => {
    const app = makeApp({ status: 'success', data: { results: [{ id: 'p1' }], totalFound: 1 }, latencyMs: 5 });
    const res = await app.request('/api/products/search?q=shoes');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.totalFound).toBe(1);
  });

  it('passes query string q to router inputs', async () => {
    const router = makeRouter();
    const app = createApp({ shopId: SHOP_ID, db: makeDb() as any, router: router as any, agentsJson: MOCK_AGENTS_JSON, adminApiKey: ADMIN_KEY, corsOrigin: 'http://localhost:3000' });
    await app.request('/api/products/search?q=sneakers');
    const [execReq] = router.execute.mock.calls[0]! as any[];
    expect(execReq.inputs.query).toBe('sneakers');
  });

  it('passes size, min_price, and in_stock filters to router', async () => {
    const router = makeRouter();
    const app = createApp({ shopId: SHOP_ID, db: makeDb() as any, router: router as any, agentsJson: MOCK_AGENTS_JSON, adminApiKey: ADMIN_KEY, corsOrigin: 'http://localhost:3000' });
    await app.request('/api/products/search?q=shoes&size=11&min_price=50&in_stock=true');
    const [execReq] = router.execute.mock.calls[0]! as any[];
    expect(execReq.inputs.filters).toMatchObject({ size: '11', minPrice: 50, inStock: true });
  });

  it('uses isAuthenticated: true (public route)', async () => {
    const router = makeRouter();
    const app = createApp({ shopId: SHOP_ID, db: makeDb() as any, router: router as any, agentsJson: MOCK_AGENTS_JSON, adminApiKey: ADMIN_KEY, corsOrigin: 'http://localhost:3000' });
    await app.request('/api/products/search?q=shoes');
    const [execReq] = router.execute.mock.calls[0]! as any[];
    expect(execReq.authContext.isAuthenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/products/:product_id
// ---------------------------------------------------------------------------

describe('GET /api/products/:product_id', () => {
  it('returns 200 with product data', async () => {
    const product = { id: 'prod-1', title: 'Air Max 90', variantsJson: [] };
    const app = makeApp({ status: 'success', data: { product }, latencyMs: 5 });
    const res = await app.request('/api/products/gid%3A%2F%2Fshopify%2FProduct%2F123');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.product.title).toBe('Air Max 90');
  });

  it('returns 404 when product not found', async () => {
    const router = makeRouter({ status: 'error' as const, data: undefined, latencyMs: 5 } as any);
    // Override with error result
    (router.execute as any).mockResolvedValue({ status: 'error', error: { code: 'NOT_FOUND', message: 'Product not found' }, latencyMs: 5 });
    const app = createApp({ shopId: SHOP_ID, db: makeDb() as any, router: router as any, agentsJson: MOCK_AGENTS_JSON, adminApiKey: ADMIN_KEY, corsOrigin: 'http://localhost:3000' });
    const res = await app.request('/api/products/999999');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/cart  (BUILDSHEET required: without auth returns 401)
// ---------------------------------------------------------------------------

describe('POST /api/cart', () => {
  it('returns 401 without Authorization header', async () => {
    const app = makeApp();
    const res = await app.request('/api/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with non-Bearer Authorization header', async () => {
    const app = makeApp();
    const res = await app.request('/api/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic dXNlcjpwYXNz' },
      body: JSON.stringify({ lines: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 201 with cart data when bearer token provided', async () => {
    const cartData = { cart_id: 'gid://shopify/Cart/abc', lines: [], subtotal: '0.00', currency: 'USD' };
    const app = makeApp({ status: 'success', data: cartData, latencyMs: 5 });
    const res = await app.request('/api/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}`, 'X-Shop-Domain': 'test.myshopify.com' },
      body: JSON.stringify({ lines: [{ variant_id: 'gid://shopify/ProductVariant/1', quantity: 1 }] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.cart_id).toBeDefined();
  });

  it('forwards bearer token to authContext', async () => {
    const router = makeRouter({ status: 'success', data: { cart_id: 'c1' }, latencyMs: 5 });
    const app = createApp({ shopId: SHOP_ID, db: makeDb() as any, router: router as any, agentsJson: MOCK_AGENTS_JSON, adminApiKey: ADMIN_KEY, corsOrigin: 'http://localhost:3000' });
    await app.request('/api/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}`, 'X-Shop-Domain': 'test.myshopify.com' },
      body: JSON.stringify({ lines: [{ variant_id: 'gid://shopify/ProductVariant/1', quantity: 1 }] }),
    });
    const [execReq] = router.execute.mock.calls[0]! as any[];
    expect(execReq.authContext.isAuthenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/cart/:cart_id/checkout
// ---------------------------------------------------------------------------

describe('POST /api/cart/:cart_id/checkout', () => {
  it('returns 401 without Authorization header', async () => {
    const app = makeApp();
    const res = await app.request('/api/cart/gid%3A%2F%2Fshopify%2FCart%2Fabc/checkout', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('returns checkout_url when authenticated', async () => {
    const app = makeApp({ status: 'success', data: { checkout_url: 'https://test.myshopify.com/checkouts/c/abc' }, latencyMs: 5 });
    const res = await app.request('/api/cart/gid%3A%2F%2Fshopify%2FCart%2Fabc/checkout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'X-Shop-Domain': 'test.myshopify.com' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.checkout_url).toContain('https://');
  });
});

// ---------------------------------------------------------------------------
// GET /api/success-score
// ---------------------------------------------------------------------------

describe('GET /api/success-score', () => {
  it('returns 200 with scores array', async () => {
    const db = makeDb();
    (db.query.successScores.findMany as any).mockResolvedValue([
      { toolName: 'search_products', successRate: 0.98, totalRuns: 100 },
    ]);
    const app = createApp({ shopId: SHOP_ID, db: db as any, router: makeRouter() as any, agentsJson: MOCK_AGENTS_JSON, adminApiKey: ADMIN_KEY, corsOrigin: 'http://localhost:3000' });
    const res = await app.request('/api/success-score');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.scores).toHaveLength(1);
  });
});
