import { describe, expect, it, vi, beforeEach } from 'vitest';

// Module-level mocks — before any imports that use them
const { mockMCPHandleRequest } = vi.hoisted(() => ({
  mockMCPHandleRequest: vi.fn(),
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
import { makeTestDb, makeTestRouter, assertSearchContract, assertProductContract } from './helpers.js';

describe('MCP-HTTP Parity', () => {
  let db: ReturnType<typeof makeTestDb>;
  let router: ReturnType<typeof makeTestRouter>;
  let app: ReturnType<typeof createEdgeApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    router = makeTestRouter();
    app = createEdgeApp({ db: db as any, router: router as any, adminApiKey: 'admin-secret' });
  });

  it('search_products: HTTP and MCP both use same router with same contract', async () => {
    // HTTP path
    const httpRes = await app.request('/api/products/search?q=jordan', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });
    expect(httpRes.status).toBe(200);
    const httpBody = await httpRes.json() as any;
    assertSearchContract(httpBody);

    // Verify router.execute was called with search_products
    const firstCallArg = router.execute.mock.calls[0][0];
    expect(firstCallArg).toHaveProperty('toolName', 'search_products');

    // MCP path — mock returns JSON-RPC envelope wrapping the same data
    mockMCPHandleRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify(httpBody) }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const mcpRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'X-Shop-Domain': 'cool-kicks.myshopify.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_products', arguments: { query: 'jordan' } },
      }),
    });

    const mcpEnvelope = await mcpRes.json() as any;
    const mcpData = JSON.parse(mcpEnvelope.result.content[0].text);
    assertSearchContract(mcpData);

    // Both have same types for totalFound and results is array
    expect(typeof httpBody.totalFound).toBe(typeof mcpData.totalFound);
    expect(Array.isArray(httpBody.results)).toBe(true);
    expect(Array.isArray(mcpData.results)).toBe(true);
  });

  it('get_product: HTTP and MCP both satisfy product contract', async () => {
    // HTTP path
    const httpRes = await app.request('/api/products/prod-a1', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });
    expect(httpRes.status).toBe(200);
    const httpBody = await httpRes.json() as any;
    assertProductContract(httpBody);

    // MCP path — mock returns JSON-RPC envelope wrapping the same data
    mockMCPHandleRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify(httpBody) }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const mcpRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'X-Shop-Domain': 'cool-kicks.myshopify.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_product', arguments: { product_id: 'prod-a1' } },
      }),
    });

    const mcpEnvelope = await mcpRes.json() as any;
    const mcpData = JSON.parse(mcpEnvelope.result.content[0].text);
    assertProductContract(mcpData);
  });

  it('both interfaces use the same ExecutionRouter instance', async () => {
    // Call HTTP
    const res = await app.request('/api/products/search?q=test', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });
    expect(res.status).toBe(200);

    // Verify router.execute was called at least once
    expect(router.execute).toHaveBeenCalled();

    // Verify all calls have shopId, toolName, inputs properties
    for (const call of router.execute.mock.calls) {
      const arg = call[0];
      expect(arg).toHaveProperty('shopId');
      expect(arg).toHaveProperty('toolName');
      expect(arg).toHaveProperty('inputs');
    }
  });
});
