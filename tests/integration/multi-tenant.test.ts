import { describe, expect, it, vi, beforeEach } from 'vitest';

// Module-level mocks — same pattern as safety-gating
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
import { SHOP_A, SHOP_B, makeTestDb, makeTestRouter, makeAgentsJson } from './helpers.js';

describe('Multi-Tenant Isolation', () => {
  let db: ReturnType<typeof makeTestDb>;
  let router: ReturnType<typeof makeTestRouter>;
  let app: ReturnType<typeof createEdgeApp>;

  const MANIFEST_A = {
    id: 'manifest-a', shopId: 'shop-a-uuid', version: 1,
    capabilitiesJson: {}, toolsJson: {},
    agentsJson: makeAgentsJson('Cool Kicks', 'https://cool-kicks.agent-channel.dev'),
    generatedAt: new Date(), isActive: true,
  };

  const MANIFEST_B = {
    id: 'manifest-b', shopId: 'shop-b-uuid', version: 1,
    capabilitiesJson: {}, toolsJson: {},
    agentsJson: makeAgentsJson('Sneaker Palace', 'https://sneaker-palace.agent-channel.dev'),
    generatedAt: new Date(), isActive: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    router = makeTestRouter();
    app = createEdgeApp({ db: db as any, router: router as any, adminApiKey: 'admin-secret' });
  });

  it('shop A returns shop A manifest', async () => {
    db.query.shops.findFirst.mockResolvedValue(SHOP_A);
    db.query.manifests.findFirst.mockResolvedValue(MANIFEST_A);

    const res = await app.request('/.well-known/agents.json', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toContain('Cool Kicks');
  });

  it('shop B returns shop B manifest', async () => {
    db.query.shops.findFirst.mockResolvedValue(SHOP_B);
    db.query.manifests.findFirst.mockResolvedValue(MANIFEST_B);

    const res = await app.request('/.well-known/agents.json', {
      headers: { 'X-Shop-Domain': 'sneaker-palace.myshopify.com' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toContain('Sneaker Palace');
  });

  it('shop A search uses shop A shopId', async () => {
    db.query.shops.findFirst.mockResolvedValue(SHOP_A);
    db.query.manifests.findFirst.mockResolvedValue(MANIFEST_A);

    await app.request('/api/products/search?q=sneakers', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });

    expect(router.execute).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-a-uuid' }),
      expect.anything(),
    );
  });

  it('shop B search uses shop B shopId (no cross-contamination)', async () => {
    db.query.shops.findFirst.mockResolvedValue(SHOP_B);
    db.query.manifests.findFirst.mockResolvedValue(MANIFEST_B);

    await app.request('/api/products/search?q=sneakers', {
      headers: { 'X-Shop-Domain': 'sneaker-palace.myshopify.com' },
    });

    expect(router.execute).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-b-uuid' }),
      expect.anything(),
    );
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
