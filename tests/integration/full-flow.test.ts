import { describe, expect, it, vi, beforeEach } from 'vitest';

// Module-level mocks — before any imports that use them
const { mockMCPHandleRequest } = vi.hoisted(() => ({
  mockMCPHandleRequest: vi.fn().mockResolvedValue(
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  ),
}));

vi.mock('../../packages/edge-worker/src/mcp/handler.js', () => ({
  createMCPHandler: vi.fn().mockReturnValue({ handleRequest: mockMCPHandleRequest }),
}));

vi.mock('@shopify-agent-channel/shopify-auth', () => ({
  generateInstallUrl: vi.fn(),
  handleOAuthCallback: vi.fn(),
  verifyShopifyWebhook: vi.fn(),
  handleAppUninstalled: vi.fn(),
  handleProductsUpdate: vi.fn(),
}));

vi.mock('@shopify-agent-channel/ingest', () => ({
  ingestShop: vi.fn().mockResolvedValue({ productsUpserted: 0, productsArchived: 0, totalVariants: 0 }),
}));

import { createEdgeApp } from '../../packages/edge-worker/src/app.js';
import {
  makeTestDb,
  makeTestRouter,
  assertSearchContract,
  assertProductContract,
  assertCartContract,
  assertCheckoutContract,
} from './helpers.js';

describe('Full Flow — manifest → search → product → cart → checkout', () => {
  let db: ReturnType<typeof makeTestDb>;
  let router: ReturnType<typeof makeTestRouter>;
  let app: ReturnType<typeof createEdgeApp>;
  const HEADERS = { 'X-Shop-Domain': 'cool-kicks.myshopify.com' };
  const AUTH_HEADERS = { ...HEADERS, 'Authorization': 'Bearer test-agent-token' };

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    router = makeTestRouter();
    app = createEdgeApp({ db: db as any, router: router as any, adminApiKey: 'admin-secret' });
  });

  it('step 1: manifest is served at /.well-known/agents.json', async () => {
    const res = await app.request('/.well-known/agents.json', { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.capabilities).toHaveLength(4);
    expect(body.name).toContain('Cool Kicks');
  });

  it('step 2: search_products returns results matching contract', async () => {
    const res = await app.request('/api/products/search?q=jordan', { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    assertSearchContract(body);
    expect(body.totalFound).toBeGreaterThan(0);
  });

  it('step 3: get_product returns product detail matching contract', async () => {
    const res = await app.request('/api/products/gid%3A%2F%2Fshopify%2FProduct%2F1001', { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    assertProductContract(body);
  });

  it('step 4: create_cart returns cart with id', async () => {
    const res = await app.request('/api/cart', {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [{ variant_id: 'gid://shopify/ProductVariant/2001', quantity: 1 }] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    assertCartContract(body);
  });

  it('step 5: initiate_checkout returns checkout_url', async () => {
    const res = await app.request('/api/cart/cart-123/checkout', {
      method: 'POST',
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    assertCheckoutContract(body);
    expect(body.checkout_url).toContain('checkout');
  });
});
