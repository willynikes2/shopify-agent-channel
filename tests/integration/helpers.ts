import { vi, expect } from 'vitest';
import type { AgentsJson } from '../../packages/manifest/src/generateAgentsJson.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const SHOP_A = {
  id: 'shop-a-uuid',
  shopDomain: 'cool-kicks.myshopify.com',
  shopName: 'Cool Kicks',
  agentHostname: 'agent.coolkicks.com',
  agentEnabled: true,
  uninstalledAt: null,
  shopifyAccessTokenEncrypted: 'enc-token-a',
  shopifyScopes: 'read_products,write_checkouts',
  shopCurrency: 'USD',
  plan: 'starter',
  installedAt: new Date(),
  lastSyncedAt: new Date(),
  lastVerifiedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export const SHOP_B = {
  id: 'shop-b-uuid',
  shopDomain: 'sneaker-palace.myshopify.com',
  shopName: 'Sneaker Palace',
  agentHostname: null,
  agentEnabled: true,
  uninstalledAt: null,
  shopifyAccessTokenEncrypted: 'enc-token-b',
  shopifyScopes: 'read_products,write_checkouts',
  shopCurrency: 'EUR',
  plan: 'starter',
  installedAt: new Date(),
  lastSyncedAt: new Date(),
  lastVerifiedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export const PRODUCTS_A = [
  {
    id: 'prod-a1', shopId: 'shop-a-uuid',
    shopifyProductId: 'gid://shopify/Product/1001',
    title: 'Air Jordan 1 Retro High', description: 'Classic basketball shoe',
    productType: 'Shoes', vendor: 'Nike', tags: ['jordan', 'basketball'],
    status: 'active',
    variantsJson: [
      { id: 'gid://shopify/ProductVariant/2001', title: 'Size 11', price: '170.00', sku: 'AJ1-11', inventoryQuantity: 5, selectedOptions: [{ name: 'Size', value: '11' }] },
    ],
    imagesJson: [{ url: 'https://cdn.shopify.com/aj1.jpg', altText: 'AJ1' }],
    shopifyUpdatedAt: new Date(), syncedAt: new Date(),
  },
];

export function makeAgentsJson(shopName: string, baseUrl: string): AgentsJson {
  return {
    name: `${shopName} Agent Channel`,
    version: '0.1.0',
    platform: 'shopify',
    issuer: 'shopify-agent-channel',
    base_url: baseUrl,
    interfaces: {
      mcp: { url: `${baseUrl}/mcp`, transport: 'sse' },
      http: { base_url: `${baseUrl}/api` },
    },
    auth: {
      read: { mode: 'public' },
      write: { mode: 'bearer', description: 'Bearer token required', confirmation_note: 'checkout_url returned' },
    },
    capabilities: [
      { id: 'search_products', type: 'search', safety: 'low', requires_auth: false, input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, output_schema: { type: 'object' }, billing: { model: 'free' } },
      { id: 'get_product', type: 'read', safety: 'low', requires_auth: false, input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] }, output_schema: { type: 'object' }, billing: { model: 'free' } },
      { id: 'create_cart', type: 'cart', safety: 'medium', requires_auth: true, input_schema: { type: 'object', properties: { lines: { type: 'array' } }, required: ['lines'] }, output_schema: { type: 'object' }, billing: { model: 'free' } },
      { id: 'initiate_checkout', type: 'checkout', safety: 'high', requires_auth: true, input_schema: { type: 'object', properties: { cart_id: { type: 'string' } }, required: ['cart_id'] }, output_schema: { type: 'object' }, billing: { model: 'free' } },
    ],
    store_info: { currency: 'USD', product_count: 50, last_synced: null },
    reliability: { nightly_reverify: true, success_score_url: `${baseUrl}/api/success-score` },
  };
}

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

export function makeTestDb(options: { shops?: any[]; manifests?: any[] } = {}) {
  const shops = options.shops ?? [SHOP_A];
  const manifestA = {
    id: 'manifest-a', shopId: 'shop-a-uuid', version: 1,
    capabilitiesJson: {}, toolsJson: {},
    agentsJson: makeAgentsJson('Cool Kicks', 'https://cool-kicks.agent-channel.dev'),
    generatedAt: new Date(), isActive: true,
  };
  const allManifests = options.manifests ?? [manifestA];

  return {
    query: {
      shops: {
        findFirst: vi.fn().mockResolvedValue(shops[0] ?? null),
        findMany: vi.fn().mockResolvedValue(shops),
      },
      products: {
        findFirst: vi.fn().mockResolvedValue(PRODUCTS_A[0]),
        findMany: vi.fn().mockResolvedValue(PRODUCTS_A),
      },
      manifests: {
        findFirst: vi.fn().mockResolvedValue(allManifests[0] ?? null),
      },
      successScores: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      toolRuns: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock router factory
// ---------------------------------------------------------------------------

export function makeTestRouter() {
  return {
    execute: vi.fn().mockImplementation(async (request: any) => {
      switch (request.toolName) {
        case 'search_products':
          return { status: 'success', data: { results: [{ id: 'prod-a1', title: 'Air Jordan 1' }], totalFound: 1 }, latencyMs: 5 };
        case 'get_product':
          return { status: 'success', data: { product: { id: 'prod-a1', title: 'Air Jordan 1', variants: [] } }, latencyMs: 5 };
        case 'create_cart':
          return { status: 'success', data: { cart_id: 'cart-123', lines: [], subtotal: '170.00', currency: 'USD' }, latencyMs: 10 };
        case 'initiate_checkout':
          return { status: 'success', data: { checkout_url: 'https://cool-kicks.myshopify.com/checkout/abc123' }, latencyMs: 10 };
        default:
          return { status: 'error', error: { code: 'UNKNOWN_TOOL', message: `Unknown: ${request.toolName}` }, latencyMs: 1 };
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// Contract assertions
// ---------------------------------------------------------------------------

export function assertSearchContract(data: any) {
  expect(data).toHaveProperty('results');
  expect(data).toHaveProperty('totalFound');
  expect(Array.isArray(data.results)).toBe(true);
  expect(typeof data.totalFound).toBe('number');
}

export function assertProductContract(data: any) {
  expect(data).toHaveProperty('product');
  expect(data.product).toHaveProperty('id');
  expect(data.product).toHaveProperty('title');
}

export function assertCartContract(data: any) {
  expect(data).toHaveProperty('cart_id');
  expect(typeof data.cart_id).toBe('string');
}

export function assertCheckoutContract(data: any) {
  expect(data).toHaveProperty('checkout_url');
  expect(typeof data.checkout_url).toBe('string');
  expect(data.checkout_url).toMatch(/^https?:\/\//);
}
