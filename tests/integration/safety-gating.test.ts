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
import { makeTestDb, makeTestRouter, assertCartContract, assertCheckoutContract } from './helpers.js';

describe('Safety Gating', () => {
  let db: ReturnType<typeof makeTestDb>;
  let router: ReturnType<typeof makeTestRouter>;
  let app: ReturnType<typeof createEdgeApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    router = makeTestRouter();
    app = createEdgeApp({ db: db as any, router: router as any, adminApiKey: 'admin-secret' });
  });

  it('POST /api/cart without auth returns 401', async () => {
    const res = await app.request('/api/cart', {
      method: 'POST',
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [{ variant_id: 'v1', quantity: 1 }] }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/cart with Bearer token returns 201 + cart contract', async () => {
    const res = await app.request('/api/cart', {
      method: 'POST',
      headers: {
        'X-Shop-Domain': 'cool-kicks.myshopify.com',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-agent-token',
      },
      body: JSON.stringify({ lines: [{ variant_id: 'v1', quantity: 1 }] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    assertCartContract(body);
  });

  it('POST /api/cart/:id/checkout with auth returns checkout contract', async () => {
    const res = await app.request('/api/cart/cart-123/checkout', {
      method: 'POST',
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com', 'Authorization': 'Bearer test-agent-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    assertCheckoutContract(body);
  });

  it('returns 429 with Retry-After when write limit exceeded', async () => {
    for (let i = 0; i < 30; i++) {
      await app.request('/api/cart', {
        method: 'POST',
        headers: {
          'X-Shop-Domain': 'cool-kicks.myshopify.com',
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-agent-token',
        },
        body: JSON.stringify({ lines: [{ variant_id: 'v1', quantity: 1 }] }),
      });
    }
    const res = await app.request('/api/cart', {
      method: 'POST',
      headers: {
        'X-Shop-Domain': 'cool-kicks.myshopify.com',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-agent-token',
      },
      body: JSON.stringify({ lines: [{ variant_id: 'v1', quantity: 1 }] }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeDefined();
  });

  it('unknown shop domain returns 404', async () => {
    db.query.shops.findFirst.mockResolvedValue(null);
    const res = await app.request('/api/products/search?q=test', {
      headers: { 'X-Shop-Domain': 'nonexistent.myshopify.com' },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe('Unknown shop endpoint');
  });
});
