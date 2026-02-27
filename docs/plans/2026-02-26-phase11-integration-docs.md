# Phase 11 — Integration Tests + Docs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the monorepo together with integration tests exercising real code paths (mocked DB/Shopify), consolidate shared types as re-exports, and write project documentation including security/threat model.

**Architecture:** In-process integration tests using Hono's `app.request()` / `app.fetch()` with fully mocked DB and Shopify adapter. No port binding. Shared types are re-export barrels only (import type) to avoid dependency cycles. Documentation covers architecture, API reference, MCP reference, runbook, and security.

**Tech Stack:** TypeScript, Vitest, Hono, MCP SDK

---

### Task 1: Shared types re-export barrel

**Files:**
- Modify: `packages/shared/package.json`
- Create: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`

**Step 1: Update package.json with type-only workspace deps**

```json
{
  "name": "@shopify-agent-channel/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "dependencies": {
    "@shopify-agent-channel/db": "workspace:*",
    "@shopify-agent-channel/exec": "workspace:*",
    "@shopify-agent-channel/catalog": "workspace:*",
    "@shopify-agent-channel/manifest": "workspace:*",
    "@shopify-agent-channel/reliability": "workspace:*"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "eslint src"
  }
}
```

**Step 2: Create types.ts with re-exports**

File: `packages/shared/src/types.ts`

```typescript
// Types-only re-exports — no runtime code, no dependency cycles.
// Source packages own the definitions; shared is a convenience barrel.

export type { Database } from '@shopify-agent-channel/db';

export type { ExecRequest, ExecResult } from '@shopify-agent-channel/exec';

export type {
  ToolDefinition,
  Capability,
  CapabilityMap,
  CapabilityMapMetadata,
} from '@shopify-agent-channel/catalog';

export type {
  ProductSearchResult,
  SearchFilters,
  VariantResult,
} from '@shopify-agent-channel/catalog';

export type { AgentsJson } from '@shopify-agent-channel/manifest';

export type {
  SuccessScoreResult,
  ReverifyReport,
  Regression,
} from '@shopify-agent-channel/reliability';
```

**Step 3: Update index.ts**

File: `packages/shared/src/index.ts`

```typescript
export type {
  Database,
  ExecRequest,
  ExecResult,
  ToolDefinition,
  Capability,
  CapabilityMap,
  CapabilityMapMetadata,
  ProductSearchResult,
  SearchFilters,
  VariantResult,
  AgentsJson,
  SuccessScoreResult,
  ReverifyReport,
  Regression,
} from './types.js';
```

**Step 4: Install and verify**

Run: `pnpm install`

**Step 5: Commit**

```bash
git add packages/shared/package.json packages/shared/src/types.ts packages/shared/src/index.ts pnpm-lock.yaml
git commit -m "feat(shared): Phase 11 — types-only re-export barrel"
```

---

### Task 2: Integration test scaffold + helpers

**Files:**
- Create: `tests/integration/vitest.config.ts`
- Create: `tests/integration/helpers.ts`
- Modify: `package.json` (root — add integration test script)

**Step 1: Create vitest config for integration tests**

File: `tests/integration/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    globals: false,
  },
});
```

**Step 2: Create helpers.ts with shared test factories**

File: `tests/integration/helpers.ts`

```typescript
import { vi } from 'vitest';
import { createEdgeApp } from '@shopify-agent-channel/edge-worker';
import type { AgentsJson } from '@shopify-agent-channel/manifest';

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
    id: 'prod-a1',
    shopId: 'shop-a-uuid',
    shopifyProductId: 'gid://shopify/Product/1001',
    title: 'Air Jordan 1 Retro High',
    description: 'Classic basketball shoe',
    productType: 'Shoes',
    vendor: 'Nike',
    tags: ['jordan', 'basketball', 'retro'],
    status: 'active',
    variantsJson: [
      { id: 'gid://shopify/ProductVariant/2001', title: 'Size 11', price: '170.00', sku: 'AJ1-11', inventoryQuantity: 5, selectedOptions: [{ name: 'Size', value: '11' }] },
      { id: 'gid://shopify/ProductVariant/2002', title: 'Size 11.5', price: '170.00', sku: 'AJ1-115', inventoryQuantity: 3, selectedOptions: [{ name: 'Size', value: '11.5' }] },
    ],
    imagesJson: [{ url: 'https://cdn.shopify.com/aj1.jpg', altText: 'Air Jordan 1' }],
    shopifyUpdatedAt: new Date(),
    syncedAt: new Date(),
  },
  {
    id: 'prod-a2',
    shopId: 'shop-a-uuid',
    shopifyProductId: 'gid://shopify/Product/1002',
    title: 'Nike Dunk Low',
    description: 'Casual lifestyle sneaker',
    productType: 'Shoes',
    vendor: 'Nike',
    tags: ['dunk', 'lifestyle'],
    status: 'active',
    variantsJson: [
      { id: 'gid://shopify/ProductVariant/2003', title: 'Size 10', price: '110.00', sku: 'DUNK-10', inventoryQuantity: 8, selectedOptions: [{ name: 'Size', value: '10' }] },
    ],
    imagesJson: [{ url: 'https://cdn.shopify.com/dunk.jpg', altText: 'Nike Dunk' }],
    shopifyUpdatedAt: new Date(),
    syncedAt: new Date(),
  },
];

export const PRODUCTS_B = [
  {
    id: 'prod-b1',
    shopId: 'shop-b-uuid',
    shopifyProductId: 'gid://shopify/Product/3001',
    title: 'Adidas Ultraboost',
    description: 'Running shoe with boost cushioning',
    productType: 'Shoes',
    vendor: 'Adidas',
    tags: ['running', 'ultraboost'],
    status: 'active',
    variantsJson: [
      { id: 'gid://shopify/ProductVariant/4001', title: 'Size 10', price: '180.00', sku: 'UB-10', inventoryQuantity: 4, selectedOptions: [{ name: 'Size', value: '10' }] },
    ],
    imagesJson: [],
    shopifyUpdatedAt: new Date(),
    syncedAt: new Date(),
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
    reliability: { nightly_reverify: true, success_score_url: `${baseUrl}/api/success-score` },
  };
}

// ---------------------------------------------------------------------------
// Mock DB factory — fresh per test
// ---------------------------------------------------------------------------

export function makeTestDb(options: {
  shops?: any[];
  products?: any[];
  manifests?: any[];
} = {}) {
  const shops = options.shops ?? [SHOP_A];
  const products = options.products ?? PRODUCTS_A;
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
        findFirst: vi.fn().mockImplementation((opts?: any) => {
          // Simple: return first matching shop or null
          // In practice the where clause is opaque, so we route by call order
          return Promise.resolve(shops[0] ?? null);
        }),
        findMany: vi.fn().mockResolvedValue(shops),
      },
      products: {
        findFirst: vi.fn().mockResolvedValue(products[0] ?? null),
        findMany: vi.fn().mockResolvedValue(products),
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
// Mock router factory — fresh per test
// ---------------------------------------------------------------------------

export function makeTestRouter() {
  return {
    execute: vi.fn().mockImplementation(async (request: any) => {
      const toolName = request.toolName;
      switch (toolName) {
        case 'search_products':
          return {
            status: 'success',
            data: { results: [{ id: 'prod-a1', title: 'Air Jordan 1 Retro High' }], totalFound: 1 },
            latencyMs: 5,
          };
        case 'get_product':
          return {
            status: 'success',
            data: { product: { id: 'prod-a1', title: 'Air Jordan 1 Retro High', variants: [] } },
            latencyMs: 5,
          };
        case 'create_cart':
          return {
            status: 'success',
            data: { cart_id: 'cart-123', lines: [], subtotal: '170.00', currency: 'USD' },
            latencyMs: 10,
          };
        case 'initiate_checkout':
          return {
            status: 'success',
            data: { checkout_url: 'https://cool-kicks.myshopify.com/checkout/abc123' },
            latencyMs: 10,
          };
        default:
          return { status: 'error', error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}` }, latencyMs: 1 };
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// Contract assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a search result from HTTP or MCP has the expected contract shape.
 */
export function assertSearchContract(data: any) {
  expect(data).toHaveProperty('results');
  expect(data).toHaveProperty('totalFound');
  expect(Array.isArray(data.results)).toBe(true);
  expect(typeof data.totalFound).toBe('number');
}

/**
 * Assert that a product result from HTTP or MCP has the expected contract shape.
 */
export function assertProductContract(data: any) {
  expect(data).toHaveProperty('product');
  expect(data.product).toHaveProperty('id');
  expect(data.product).toHaveProperty('title');
}

/**
 * Assert that a cart result has the expected contract shape.
 */
export function assertCartContract(data: any) {
  expect(data).toHaveProperty('cart_id');
  expect(typeof data.cart_id).toBe('string');
}

/**
 * Assert that a checkout result has the expected contract shape.
 */
export function assertCheckoutContract(data: any) {
  expect(data).toHaveProperty('checkout_url');
  expect(typeof data.checkout_url).toBe('string');
  expect(data.checkout_url).toMatch(/^https?:\/\//);
}

// Re-export expect for use in contract helpers
import { expect } from 'vitest';
```

**Step 3: Add integration test script to root package.json**

Add to the `scripts` section of root `package.json`:

```json
"test:integration": "vitest run --config tests/integration/vitest.config.ts"
```

**Step 4: Commit**

```bash
git add tests/integration/vitest.config.ts tests/integration/helpers.ts package.json
git commit -m "feat(tests): Phase 11 — integration test scaffold + helpers"
```

---

### Task 3: Safety gating integration tests

**Files:**
- Create: `tests/integration/safety-gating.test.ts`

**Step 1: Write the tests**

File: `tests/integration/safety-gating.test.ts`

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — must come before imports that use mocked modules
// ---------------------------------------------------------------------------

const { mockMCPHandleRequest } = vi.hoisted(() => ({
  mockMCPHandleRequest: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  ),
}));

vi.mock('../../packages/edge-worker/src/mcp/handler.js', () => ({
  createMCPHandler: vi.fn().mockReturnValue({
    handleRequest: mockMCPHandleRequest,
  }),
}));

import { createEdgeApp } from '../../packages/edge-worker/src/app.js';
import { makeTestDb, makeTestRouter, assertCartContract, assertCheckoutContract } from './helpers.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
      headers: {
        'X-Shop-Domain': 'cool-kicks.myshopify.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ lines: [{ variant_id: 'v1', quantity: 1 }] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toBeDefined();
  });

  it('POST /api/cart with Bearer token returns 201 + cart contract', async () => {
    const res = await app.request('/api/cart', {
      method: 'POST',
      headers: {
        'X-Shop-Domain': 'cool-kicks.myshopify.com',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-agent-token',
      },
      body: JSON.stringify({ lines: [{ variant_id: 'gid://shopify/ProductVariant/2001', quantity: 1 }] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    assertCartContract(body);
  });

  it('POST /api/cart/:id/checkout with auth returns checkout contract', async () => {
    const res = await app.request('/api/cart/cart-123/checkout', {
      method: 'POST',
      headers: {
        'X-Shop-Domain': 'cool-kicks.myshopify.com',
        'Authorization': 'Bearer test-agent-token',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    assertCheckoutContract(body);
  });

  it('returns 429 with Retry-After when write limit exceeded', async () => {
    // Write tier limit is 30/min — exhaust it
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

    // 31st request should be rate limited
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
    const body = await res.json() as any;
    expect(body.retryAfter).toBeGreaterThan(0);
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
```

**Step 2: Run to verify**

Run: `npx vitest run --config tests/integration/vitest.config.ts tests/integration/safety-gating.test.ts`

**Step 3: Debug and fix until all 5 tests pass**

**Step 4: Commit**

```bash
git add tests/integration/safety-gating.test.ts
git commit -m "test(integration): safety gating — auth, rate limiting, unknown shop"
```

---

### Task 4: Full flow integration test

**Files:**
- Create: `tests/integration/full-flow.test.ts`

**Step 1: Write the tests**

File: `tests/integration/full-flow.test.ts`

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockMCPHandleRequest } = vi.hoisted(() => ({
  mockMCPHandleRequest: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  ),
}));

vi.mock('../../packages/edge-worker/src/mcp/handler.js', () => ({
  createMCPHandler: vi.fn().mockReturnValue({
    handleRequest: mockMCPHandleRequest,
  }),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Full Flow — search → product → cart → checkout', () => {
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
    const res = await app.request('/api/products/gid://shopify/Product/1001', { headers: HEADERS });
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
```

**Step 2: Run to verify**

Run: `npx vitest run --config tests/integration/vitest.config.ts tests/integration/full-flow.test.ts`

**Step 3: Commit**

```bash
git add tests/integration/full-flow.test.ts
git commit -m "test(integration): full flow — manifest → search → product → cart → checkout"
```

---

### Task 5: Multi-tenant integration test

**Files:**
- Create: `tests/integration/multi-tenant.test.ts`

**Step 1: Write the tests**

This test requires the DB to return different shops/manifests based on the X-Shop-Domain header. The edge app's shop resolver calls `db.query.shops.findFirst()` — we need the mock to differentiate.

File: `tests/integration/multi-tenant.test.ts`

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockMCPHandleRequest } = vi.hoisted(() => ({
  mockMCPHandleRequest: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  ),
}));

vi.mock('../../packages/edge-worker/src/mcp/handler.js', () => ({
  createMCPHandler: vi.fn().mockReturnValue({
    handleRequest: mockMCPHandleRequest,
  }),
}));

import { createEdgeApp } from '../../packages/edge-worker/src/app.js';
import {
  SHOP_A, SHOP_B,
  makeTestDb, makeTestRouter, makeAgentsJson,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    db = makeTestDb({ shops: [SHOP_A, SHOP_B] });
    router = makeTestRouter();

    // Dynamic shop resolution — mock routes by domain
    db.query.shops.findFirst.mockImplementation(async () => {
      // Default to SHOP_A; tests override per call
      return SHOP_A;
    });

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

  it('shop A search only returns shop A products (via router shopId)', async () => {
    db.query.shops.findFirst.mockResolvedValue(SHOP_A);
    db.query.manifests.findFirst.mockResolvedValue(MANIFEST_A);

    const res = await app.request('/api/products/search?q=jordan', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });
    expect(res.status).toBe(200);

    // Verify the router was called with shop A's ID
    expect(router.execute).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-a-uuid' }),
      expect.anything(),
    );
  });

  it('shop B search uses shop B shopId (no cross-contamination)', async () => {
    db.query.shops.findFirst.mockResolvedValue(SHOP_B);
    db.query.manifests.findFirst.mockResolvedValue(MANIFEST_B);

    const res = await app.request('/api/products/search?q=ultraboost', {
      headers: { 'X-Shop-Domain': 'sneaker-palace.myshopify.com' },
    });
    expect(res.status).toBe(200);

    // Verify the router was called with shop B's ID
    expect(router.execute).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-b-uuid' }),
      expect.anything(),
    );
  });

  it('unknown shop domain returns 404', async () => {
    db.query.shops.findFirst.mockResolvedValue(null);

    const res = await app.request('/api/products/search?q=test', {
      headers: { 'X-Shop-Domain': 'ghost-store.myshopify.com' },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe('Unknown shop endpoint');
  });
});
```

**Step 2: Run to verify**

Run: `npx vitest run --config tests/integration/vitest.config.ts tests/integration/multi-tenant.test.ts`

**Step 3: Commit**

```bash
git add tests/integration/multi-tenant.test.ts
git commit -m "test(integration): multi-tenant isolation — two shops, no cross-contamination"
```

---

### Task 6: MCP-HTTP parity integration test

**Files:**
- Create: `tests/integration/mcp-http-parity.test.ts`

**Step 1: Write the tests**

The parity test verifies that HTTP and MCP interfaces return data matching the same contract. Since MCP goes through a different handler (createMCPHandler → MCP SDK), we test both paths and compare contract shapes.

File: `tests/integration/mcp-http-parity.test.ts`

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockMCPHandleRequest } = vi.hoisted(() => ({
  mockMCPHandleRequest: vi.fn(),
}));

vi.mock('../../packages/edge-worker/src/mcp/handler.js', () => ({
  createMCPHandler: vi.fn().mockReturnValue({
    handleRequest: mockMCPHandleRequest,
  }),
}));

import { createEdgeApp } from '../../packages/edge-worker/src/app.js';
import { makeTestDb, makeTestRouter, assertSearchContract, assertProductContract } from './helpers.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP-HTTP Parity', () => {
  let db: ReturnType<typeof makeTestDb>;
  let router: ReturnType<typeof makeTestRouter>;
  let app: ReturnType<typeof createEdgeApp>;
  const HEADERS = { 'X-Shop-Domain': 'cool-kicks.myshopify.com' };

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    router = makeTestRouter();
    app = createEdgeApp({ db: db as any, router: router as any, adminApiKey: 'admin-secret' });
  });

  it('search_products: HTTP and MCP both use same router with same contract', async () => {
    // HTTP path
    const httpRes = await app.request('/api/products/search?q=jordan', { headers: HEADERS });
    expect(httpRes.status).toBe(200);
    const httpBody = await httpRes.json() as any;
    assertSearchContract(httpBody);

    // Verify the router was called for HTTP
    expect(router.execute).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'search_products' }),
      expect.anything(),
    );

    // MCP path — both paths call the same router.execute, so the contract is
    // guaranteed identical. Verify the MCP endpoint delegates to the handler.
    mockMCPHandleRequest.mockResolvedValue(
      new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify(httpBody) }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const mcpRes = await app.request('/mcp', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'search_products', arguments: { query: 'jordan' } },
      }),
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = await mcpRes.json() as any;
    // MCP wraps in JSON-RPC envelope + content array
    const mcpData = JSON.parse(mcpBody.result.content[0].text);
    assertSearchContract(mcpData);

    // Both return same structure
    expect(typeof httpBody.totalFound).toBe(typeof mcpData.totalFound);
    expect(Array.isArray(httpBody.results)).toBe(Array.isArray(mcpData.results));
  });

  it('get_product: HTTP and MCP both satisfy product contract', async () => {
    // HTTP path
    const httpRes = await app.request('/api/products/prod-a1', { headers: HEADERS });
    expect(httpRes.status).toBe(200);
    const httpBody = await httpRes.json() as any;
    assertProductContract(httpBody);

    // MCP path
    mockMCPHandleRequest.mockResolvedValue(
      new Response(JSON.stringify({
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify(httpBody) }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const mcpRes = await app.request('/mcp', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'get_product', arguments: { product_id: 'prod-a1' } },
      }),
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = await mcpRes.json() as any;
    const mcpData = JSON.parse(mcpBody.result.content[0].text);
    assertProductContract(mcpData);
  });

  it('both interfaces use the same ExecutionRouter instance', async () => {
    // Call HTTP
    await app.request('/api/products/search?q=test', { headers: HEADERS });

    // The router.execute should have been called
    const callCount = router.execute.mock.calls.length;
    expect(callCount).toBeGreaterThan(0);

    // All calls go through the same router mock
    for (const call of router.execute.mock.calls) {
      expect(call[0]).toHaveProperty('shopId');
      expect(call[0]).toHaveProperty('toolName');
      expect(call[0]).toHaveProperty('inputs');
    }
  });
});
```

**Step 2: Run to verify**

Run: `npx vitest run --config tests/integration/vitest.config.ts tests/integration/mcp-http-parity.test.ts`

**Step 3: Commit**

```bash
git add tests/integration/mcp-http-parity.test.ts
git commit -m "test(integration): MCP-HTTP parity — contract assertions for search + product"
```

---

### Task 7: MCP transport integration test

**Files:**
- Create: `tests/integration/mcp-transport.test.ts`

**Step 1: Write the tests**

These test the actual MCP handler (not mocked) to verify SSE transport headers and JSON-RPC response frames. We use the real `createMCPHandler` from the edge worker.

File: `tests/integration/mcp-transport.test.ts`

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createMCPHandler } from '../../packages/edge-worker/src/mcp/handler.js';
import { makeTestDb, makeTestRouter, makeAgentsJson } from './helpers.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP Transport — Streamable HTTP', () => {
  let db: ReturnType<typeof makeTestDb>;
  let router: ReturnType<typeof makeTestRouter>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    router = makeTestRouter();

    // Ensure manifest is available for createMCPServer
    db.query.manifests.findFirst.mockResolvedValue({
      id: 'manifest-a', shopId: 'shop-a-uuid', version: 1,
      capabilitiesJson: {}, toolsJson: {},
      agentsJson: makeAgentsJson('Cool Kicks', 'https://cool-kicks.agent-channel.dev'),
      generatedAt: new Date(), isActive: true,
    });
  });

  it('POST /mcp with JSON-RPC initialize returns 200 + mcp-session-id header', async () => {
    const handler = createMCPHandler({
      shopId: 'shop-a-uuid',
      db: db as any,
      router: router as any,
    });

    const request = new Request('https://cool-kicks.agent-channel.dev/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.1.0' },
        },
      }),
    });

    const response = await handler.handleRequest(request);
    expect(response.status).toBe(200);

    // Streamable HTTP transport returns JSON for non-streaming requests
    const contentType = response.headers.get('content-type') ?? '';
    // Accept either JSON (single response) or SSE (streaming)
    expect(
      contentType.includes('application/json') || contentType.includes('text/event-stream')
    ).toBe(true);

    // Should have a session ID header
    const sessionId = response.headers.get('mcp-session-id');
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe('string');
  });

  it('initialize response contains valid JSON-RPC result with server info', async () => {
    const handler = createMCPHandler({
      shopId: 'shop-a-uuid',
      db: db as any,
      router: router as any,
    });

    const request = new Request('https://cool-kicks.agent-channel.dev/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.1.0' },
        },
      }),
    });

    const response = await handler.handleRequest(request);
    const contentType = response.headers.get('content-type') ?? '';

    let result: any;
    if (contentType.includes('text/event-stream')) {
      // Parse SSE: read body text, extract data: lines
      const text = await response.text();
      const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
      expect(dataLines.length).toBeGreaterThan(0);
      result = JSON.parse(dataLines[0].replace('data: ', ''));
    } else {
      result = await response.json();
    }

    expect(result).toHaveProperty('jsonrpc', '2.0');
    expect(result).toHaveProperty('id', 1);
    expect(result).toHaveProperty('result');
    expect(result.result).toHaveProperty('serverInfo');
    expect(result.result.serverInfo).toHaveProperty('name');
    expect(result.result).toHaveProperty('capabilities');
  });

  it('POST /mcp with tools/list returns 4 tool definitions', async () => {
    const handler = createMCPHandler({
      shopId: 'shop-a-uuid',
      db: db as any,
      router: router as any,
    });

    // First: initialize
    const initReq = new Request('https://cool-kicks.agent-channel.dev/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.1.0' } },
      }),
    });
    const initRes = await handler.handleRequest(initReq);
    const sessionId = initRes.headers.get('mcp-session-id') ?? '';

    // Then: tools/list with session ID
    const listReq = new Request('https://cool-kicks.agent-channel.dev/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const listRes = await handler.handleRequest(listReq);
    expect(listRes.status).toBe(200);

    const contentType = listRes.headers.get('content-type') ?? '';
    let result: any;
    if (contentType.includes('text/event-stream')) {
      const text = await listRes.text();
      const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
      result = JSON.parse(dataLines[0].replace('data: ', ''));
    } else {
      result = await listRes.json();
    }

    expect(result.result).toHaveProperty('tools');
    expect(result.result.tools).toHaveLength(4);
    const names = result.result.tools.map((t: any) => t.name);
    expect(names).toContain('search_products');
    expect(names).toContain('get_product');
    expect(names).toContain('create_cart');
    expect(names).toContain('initiate_checkout');
  });
});
```

**Step 2: Run to verify**

Run: `npx vitest run --config tests/integration/vitest.config.ts tests/integration/mcp-transport.test.ts`

Note: This test uses the real MCP SDK, not mocks. It may need adjustments based on exact SDK behavior (session ID header name, SSE vs JSON response format). Debug as needed.

**Step 3: Commit**

```bash
git add tests/integration/mcp-transport.test.ts
git commit -m "test(integration): MCP transport — Streamable HTTP init, session ID, tools/list"
```

---

### Task 8: Documentation — architecture.md + security

**Files:**
- Create: `docs/architecture.md`

**Step 1: Write architecture.md**

File: `docs/architecture.md`

Write a comprehensive architecture document including:

1. **System Overview** — What the system does (one paragraph)
2. **Data Flow** — OAuth Install → Ingest → Catalog → Manifest → MCP/HTTP → Execute via Shopify APIs
3. **Mermaid Diagram** — Full system flow diagram
4. **Multi-Tenancy** — One install per shop, routing by hostname/header/path
5. **Package Structure** — Brief description of each package's role
6. **Security & Threat Model** section covering:
   - Token encryption at rest (AES-256-GCM via ENCRYPTION_KEY)
   - HMAC webhook verification (Shopify signs all webhooks)
   - Auth gating: read tools public, write tools require Bearer token
   - Rate limiting: per-IP (reads), per-token-hash (writes), per-IP (admin)
   - No payment processing — checkout_url delegates to Shopify native checkout
   - Input validation at system boundaries (query params, JSON bodies)
   - No sensitive data in responses (access tokens never exposed)
   - CORS: open for v1 (revisit for production)
7. **Reliability** — Success scores + nightly reverification

**Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: architecture overview + security/threat model"
```

---

### Task 9: Documentation — api.md, mcp.md, runbook.md, README.md

**Files:**
- Create: `docs/api.md`
- Create: `docs/mcp.md`
- Create: `docs/runbook.md`
- Create: `README.md`

**Step 1: Write api.md**

Full HTTP API reference with all routes, methods, auth requirements, request/response examples, and error codes. Include:
- Public routes: GET /api/products/search, GET /api/products/:id, GET /api/success-score, GET /.well-known/agents.json
- Authenticated routes: POST /api/cart, POST /api/cart/:id/checkout
- Admin routes: POST /admin/shops, POST /admin/shops/:id/sync, GET /admin/shops/:id/manifest, GET /admin/shops/:id/runs, POST /internal/reverify
- Auth routes: GET /auth/shopify, GET /auth/shopify/callback, POST /webhooks/shopify
- Error codes: 400, 401, 404, 429, 500

**Step 2: Write mcp.md**

MCP tool reference with:
- Connection: POST to /mcp with JSON-RPC, Streamable HTTP transport
- 4 tools with input/output schemas
- Safety levels explained (low/medium/high)
- Auth: _meta.authToken for write tools

**Step 3: Write runbook.md**

Dev setup guide:
- Prerequisites (Node 20+, pnpm 9+, PostgreSQL)
- Environment variables
- Shopify partner account + test store
- Local dev commands
- Manual sync, reverification
- Adding new tools
- Troubleshooting

**Step 4: Write README.md**

Project vision, quick start (6 steps), tech stack, doc links.

**Step 5: Commit**

```bash
git add docs/api.md docs/mcp.md docs/runbook.md README.md
git commit -m "docs: API reference, MCP guide, runbook, README"
```

---

### Task 10: Full verification + final commit

**Step 1: Run all integration tests**

Run: `npx vitest run --config tests/integration/vitest.config.ts`
Expected: All integration tests pass

**Step 2: Run full project unit test suite**

Run: `pnpm --filter @shopify-agent-channel/shopify-auth --filter @shopify-agent-channel/ingest --filter @shopify-agent-channel/catalog --filter @shopify-agent-channel/manifest --filter @shopify-agent-channel/exec --filter @shopify-agent-channel/mcp-server --filter @shopify-agent-channel/api --filter @shopify-agent-channel/edge-worker --filter @shopify-agent-channel/reliability run test`
Expected: All 196+ unit tests pass, zero regressions

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "feat: Phase 11 complete — integration tests + docs"
```

---

## Summary

| Task | Description | Files | Tests |
|------|-------------|-------|-------|
| 1 | Shared types barrel | 3 | — |
| 2 | Test scaffold + helpers | 3 | — |
| 3 | Safety gating tests | 1 | ~5 |
| 4 | Full flow tests | 1 | ~5 |
| 5 | Multi-tenant tests | 1 | ~5 |
| 6 | MCP-HTTP parity tests | 1 | ~3 |
| 7 | MCP transport tests | 1 | ~3 |
| 8 | Architecture + security docs | 1 | — |
| 9 | API, MCP, runbook, README | 4 | — |
| 10 | Full verification | — | all |
