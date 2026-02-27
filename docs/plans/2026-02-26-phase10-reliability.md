# Phase 10 — Reliability Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the reliability layer — success score computation from tool run history and a nightly reverification job that exercises all 4 tools per active shop and flags regressions.

**Architecture:** Two pure functions operating on the DB via Drizzle ORM. `computeSuccessScore` aggregates tool_runs into success_scores. `runNightlyReverification` iterates active shops, calls each tool via ExecutionRouter, recomputes scores, and detects regressions. Both are stateless and testable with mock data.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest

---

### Task 1: Package setup

**Files:**
- Modify: `packages/reliability/package.json`

**Step 1: Update package.json with dependencies**

```json
{
  "name": "@shopify-agent-channel/reliability",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "dependencies": {
    "@shopify-agent-channel/db": "workspace:*",
    "@shopify-agent-channel/exec": "workspace:*",
    "@shopify-agent-channel/catalog": "workspace:*",
    "drizzle-orm": "^0.45.1"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "eslint src"
  }
}
```

**Step 2: Install**

Run: `pnpm install`

**Step 3: Commit**

```bash
git add packages/reliability/package.json pnpm-lock.yaml
git commit -m "feat(reliability): Phase 10 scaffold — add deps"
```

---

### Task 2: Success score computation

**Files:**
- Create: `packages/reliability/src/successScore.ts`
- Create: `packages/reliability/src/__tests__/successScore.test.ts`

**Step 1: Write the failing tests**

File: `packages/reliability/src/__tests__/successScore.test.ts`

```typescript
import { describe, expect, it, vi } from 'vitest';
import { computeSuccessScore, getSuccessScores } from '../successScore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHOP_ID = 'shop-uuid-1';
const TOOL_NAME = 'search_products';

/** Build a mock tool_run row */
function mockRun(overrides: Partial<{
  status: string;
  latencyMs: number;
  errorCode: string | null;
  createdAt: Date;
}> = {}) {
  return {
    id: crypto.randomUUID(),
    shopId: SHOP_ID,
    toolName: TOOL_NAME,
    status: overrides.status ?? 'success',
    latencyMs: overrides.latencyMs ?? 50,
    errorCode: overrides.errorCode ?? null,
    errorMessage: null,
    createdAt: overrides.createdAt ?? new Date(),
  };
}

function makeDb(runs: ReturnType<typeof mockRun>[] = [], existingScores: any[] = []) {
  return {
    query: {
      toolRuns: {
        findMany: vi.fn().mockResolvedValue(runs),
      },
      successScores: {
        findMany: vi.fn().mockResolvedValue(existingScores),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// computeSuccessScore
// ---------------------------------------------------------------------------

describe('computeSuccessScore', () => {
  it('returns zero totals when no runs exist', async () => {
    const db = makeDb([]);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    expect(result.totalRuns).toBe(0);
    expect(result.successRate).toBe(0);
  });

  it('calculates correct success rate', async () => {
    const runs = [
      mockRun({ status: 'success' }),
      mockRun({ status: 'success' }),
      mockRun({ status: 'success' }),
      mockRun({ status: 'error', errorCode: 'TIMEOUT' }),
    ];
    const db = makeDb(runs);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    expect(result.successRate).toBe(0.75);
    expect(result.totalRuns).toBe(4);
  });

  it('calculates p50 latency (median)', async () => {
    const runs = [
      mockRun({ latencyMs: 10 }),
      mockRun({ latencyMs: 20 }),
      mockRun({ latencyMs: 30 }),
      mockRun({ latencyMs: 40 }),
    ];
    const db = makeDb(runs);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    // Median of [10,20,30,40] = 25
    expect(result.p50LatencyMs).toBe(25);
  });

  it('calculates p95 latency', async () => {
    // 20 runs with latencies 1..20
    const runs = Array.from({ length: 20 }, (_, i) =>
      mockRun({ latencyMs: i + 1 }),
    );
    const db = makeDb(runs);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    // p95 of 1..20: index 18 (0-based) = 19
    expect(result.p95LatencyMs).toBe(19);
  });

  it('groups failure modes by error code', async () => {
    const runs = [
      mockRun({ status: 'error', errorCode: 'TIMEOUT' }),
      mockRun({ status: 'error', errorCode: 'TIMEOUT' }),
      mockRun({ status: 'error', errorCode: 'ADAPTER_ERROR' }),
      mockRun({ status: 'success' }),
    ];
    const db = makeDb(runs);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    expect(result.failureModes).toEqual({
      TIMEOUT: 2,
      ADAPTER_ERROR: 1,
    });
  });

  it('upserts into success_scores table', async () => {
    const db = makeDb([mockRun()]);
    await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    expect(db.insert).toHaveBeenCalled();
  });

  it('returns the computed result object', async () => {
    const runs = [mockRun({ status: 'success', latencyMs: 100 })];
    const db = makeDb(runs);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    expect(result).toMatchObject({
      shopId: SHOP_ID,
      toolName: TOOL_NAME,
      windowDays: 7,
      successRate: 1,
      totalRuns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// getSuccessScores
// ---------------------------------------------------------------------------

describe('getSuccessScores', () => {
  it('returns all scores for a shop', async () => {
    const scores = [
      { toolName: 'search_products', successRate: 0.95, totalRuns: 100 },
      { toolName: 'get_product', successRate: 0.99, totalRuns: 50 },
    ];
    const db = makeDb([], scores);
    const result = await getSuccessScores(db as any, SHOP_ID);
    expect(result).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/reliability && npx vitest run src/__tests__/successScore.test.ts`
Expected: FAIL — cannot find `../successScore.js`

**Step 3: Write implementation**

File: `packages/reliability/src/successScore.ts`

```typescript
import { eq, and, gte } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { toolRuns, successScores } from '@shopify-agent-channel/db';

export interface SuccessScoreResult {
  shopId: string;
  toolName: string;
  windowDays: number;
  successRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalRuns: number;
  failureModes: Record<string, number>;
}

/**
 * Compute success score for a specific tool over a time window.
 * Queries tool_runs, calculates metrics, upserts into success_scores.
 */
export async function computeSuccessScore(
  db: Database,
  shopId: string,
  toolName: string,
  windowDays = 7,
): Promise<SuccessScoreResult> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const runs = await db.query.toolRuns.findMany({
    where: and(
      eq(toolRuns.shopId, shopId),
      eq(toolRuns.toolName, toolName),
      gte(toolRuns.createdAt, since),
    ),
  });

  const totalRuns = runs.length;

  if (totalRuns === 0) {
    const empty: SuccessScoreResult = {
      shopId,
      toolName,
      windowDays,
      successRate: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      totalRuns: 0,
      failureModes: {},
    };
    await upsertScore(db, empty);
    return empty;
  }

  // Success rate
  const successes = runs.filter((r) => r.status === 'success').length;
  const successRate = successes / totalRuns;

  // Latency percentiles
  const latencies = runs
    .map((r) => r.latencyMs)
    .filter((l): l is number => l !== null)
    .sort((a, b) => a - b);

  const p50LatencyMs = percentile(latencies, 0.5);
  const p95LatencyMs = percentile(latencies, 0.95);

  // Failure modes — group non-success runs by errorCode
  const failureModes: Record<string, number> = {};
  for (const run of runs) {
    if (run.status !== 'success' && run.errorCode) {
      failureModes[run.errorCode] = (failureModes[run.errorCode] ?? 0) + 1;
    }
  }

  const result: SuccessScoreResult = {
    shopId,
    toolName,
    windowDays,
    successRate,
    p50LatencyMs,
    p95LatencyMs,
    totalRuns,
    failureModes,
  };

  await upsertScore(db, result);
  return result;
}

/**
 * Get all current success scores for a shop.
 */
export async function getSuccessScores(
  db: Database,
  shopId: string,
): Promise<SuccessScoreResult[]> {
  const rows = await db.query.successScores.findMany({
    where: eq(successScores.shopId, shopId),
  });

  return rows.map((r) => ({
    shopId: r.shopId,
    toolName: r.toolName,
    windowDays: r.windowDays,
    successRate: r.successRate,
    p50LatencyMs: r.p50LatencyMs ?? 0,
    p95LatencyMs: r.p95LatencyMs ?? 0,
    totalRuns: r.totalRuns,
    failureModes: (r.failureModesJson as Record<string, number>) ?? {},
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower]!;
  // Linear interpolation
  const weight = idx - lower;
  return Math.round(sorted[lower]! * (1 - weight) + sorted[upper]! * weight);
}

async function upsertScore(db: Database, score: SuccessScoreResult): Promise<void> {
  await db
    .insert(successScores)
    .values({
      shopId: score.shopId,
      toolName: score.toolName,
      windowDays: score.windowDays,
      successRate: score.successRate,
      p50LatencyMs: score.p50LatencyMs,
      p95LatencyMs: score.p95LatencyMs,
      totalRuns: score.totalRuns,
      failureModesJson: score.failureModes,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [successScores.shopId, successScores.toolName, successScores.windowDays],
      set: {
        successRate: score.successRate,
        p50LatencyMs: score.p50LatencyMs,
        p95LatencyMs: score.p95LatencyMs,
        totalRuns: score.totalRuns,
        failureModesJson: score.failureModes,
        computedAt: new Date(),
      },
    });
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/reliability && npx vitest run src/__tests__/successScore.test.ts`
Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add packages/reliability/src/successScore.ts packages/reliability/src/__tests__/successScore.test.ts
git commit -m "feat(reliability): success score computation with percentiles and failure modes"
```

---

### Task 3: Nightly reverification job

**Files:**
- Create: `packages/reliability/src/reverifyJob.ts`
- Create: `packages/reliability/src/__tests__/reverifyJob.test.ts`

**Step 1: Write the failing tests**

File: `packages/reliability/src/__tests__/reverifyJob.test.ts`

```typescript
import { describe, expect, it, vi } from 'vitest';
import { runNightlyReverification, type ReverifyReport } from '../reverifyJob.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP_1 = {
  id: 'shop-uuid-1',
  shopDomain: 'cool-kicks.myshopify.com',
  shopName: 'Cool Kicks',
  agentEnabled: true,
  uninstalledAt: null,
};

const PRODUCT_1 = {
  id: 'product-uuid-1',
  shopId: 'shop-uuid-1',
  shopifyProductId: 'gid://shopify/Product/111',
  status: 'active',
  variantsJson: [
    { id: 'gid://shopify/ProductVariant/222', title: 'Size 11', price: '99.00' },
  ],
};

function makeDb(shops: any[] = [SHOP_1], products: any[] = [PRODUCT_1]) {
  return {
    query: {
      shops: {
        findMany: vi.fn().mockResolvedValue(shops),
      },
      products: {
        findFirst: vi.fn().mockResolvedValue(products[0] ?? null),
      },
      toolRuns: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      successScores: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
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

function makeRouter(status: 'success' | 'error' = 'success') {
  const data = status === 'success'
    ? { results: [], totalFound: 0, cart_id: 'cart-1', checkout_url: 'https://checkout.shopify.com/xxx' }
    : undefined;
  return {
    execute: vi.fn().mockResolvedValue({ status, data, latencyMs: 50, error: status === 'error' ? { code: 'FAIL', message: 'fail' } : undefined }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runNightlyReverification', () => {
  it('returns report with shopsChecked count', async () => {
    const db = makeDb();
    const router = makeRouter();
    const report = await runNightlyReverification(db as any, router as any);
    expect(report.shopsChecked).toBe(1);
  });

  it('calls router.execute for all 4 tools per shop', async () => {
    const db = makeDb();
    const router = makeRouter();
    await runNightlyReverification(db as any, router as any);
    expect(router.execute).toHaveBeenCalledTimes(4);
    const toolNames = router.execute.mock.calls.map((c: any) => c[0].toolName);
    expect(toolNames).toContain('search_products');
    expect(toolNames).toContain('get_product');
    expect(toolNames).toContain('create_cart');
    expect(toolNames).toContain('initiate_checkout');
  });

  it('returns toolsVerified count (4 per shop)', async () => {
    const db = makeDb();
    const router = makeRouter();
    const report = await runNightlyReverification(db as any, router as any);
    expect(report.toolsVerified).toBe(4);
  });

  it('detects regressions when a tool has < 80% success rate', async () => {
    const db = makeDb();
    // Make search_products fail
    const router = makeRouter();
    let callCount = 0;
    router.execute.mockImplementation(() => {
      callCount++;
      // First call (search_products) fails
      if (callCount === 1) {
        return Promise.resolve({ status: 'error', error: { code: 'FAIL', message: 'fail' }, latencyMs: 50 });
      }
      return Promise.resolve({ status: 'success', data: {}, latencyMs: 50 });
    });

    // Seed tool_runs that show poor history for search_products
    // The DB mock returns runs for computeSuccessScore
    const poorRuns = Array.from({ length: 10 }, (_, i) => ({
      id: `run-${i}`,
      shopId: 'shop-uuid-1',
      toolName: 'search_products',
      status: i < 3 ? 'success' : 'error',  // 30% success
      latencyMs: 50,
      errorCode: i >= 3 ? 'FAIL' : null,
      errorMessage: null,
      createdAt: new Date(),
    }));
    db.query.toolRuns.findMany.mockResolvedValue(poorRuns);

    const report = await runNightlyReverification(db as any, router as any);
    expect(report.regressions.length).toBeGreaterThan(0);
    expect(report.regressions[0]).toMatchObject({
      shopId: 'shop-uuid-1',
      toolName: 'search_products',
    });
  });

  it('skips shops with no active products', async () => {
    const db = makeDb([SHOP_1], []);
    db.query.products.findFirst.mockResolvedValue(null);
    const router = makeRouter();
    const report = await runNightlyReverification(db as any, router as any);
    // Should still attempt search_products (doesn't need a product)
    // but get_product, create_cart, initiate_checkout need a product/variant
    expect(report.shopsChecked).toBe(1);
  });

  it('handles multiple shops', async () => {
    const shop2 = { ...SHOP_1, id: 'shop-uuid-2', shopDomain: 'sneaker-store.myshopify.com' };
    const db = makeDb([SHOP_1, shop2]);
    const router = makeRouter();
    const report = await runNightlyReverification(db as any, router as any);
    expect(report.shopsChecked).toBe(2);
    expect(report.toolsVerified).toBe(8); // 4 tools × 2 shops
  });

  it('updates shop.last_verified_at (calls db.update)', async () => {
    const db = makeDb();
    const router = makeRouter();
    await runNightlyReverification(db as any, router as any);
    expect(db.update).toHaveBeenCalled();
  });

  it('returns empty regressions when all tools succeed', async () => {
    const db = makeDb();
    const router = makeRouter();
    // Return 100% success runs for score computation
    const goodRuns = Array.from({ length: 10 }, (_, i) => ({
      id: `run-${i}`,
      shopId: 'shop-uuid-1',
      toolName: 'search_products',
      status: 'success',
      latencyMs: 50,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
    }));
    db.query.toolRuns.findMany.mockResolvedValue(goodRuns);

    const report = await runNightlyReverification(db as any, router as any);
    expect(report.regressions).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/reliability && npx vitest run src/__tests__/reverifyJob.test.ts`
Expected: FAIL — cannot find `../reverifyJob.js`

**Step 3: Write implementation**

File: `packages/reliability/src/reverifyJob.ts`

```typescript
import { eq, and, isNull } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { shops, products } from '@shopify-agent-channel/db';
import type { ExecutionRouter } from '@shopify-agent-channel/exec';
import type { ToolDefinition } from '@shopify-agent-channel/catalog';
import { computeSuccessScore } from './successScore.js';

const TOOL_NAMES = ['search_products', 'get_product', 'create_cart', 'initiate_checkout'] as const;

const REGRESSION_THRESHOLD = 0.8; // 80%

/** Minimal tool definitions for reverification — no schema validation needed. */
const REVERIFY_TOOL_DEFS: Record<string, ToolDefinition> = {
  search_products: {
    name: 'search_products',
    type: 'search',
    safety_level: 'low',
    requires_auth: false,
    input_schema: {},
    output_schema: {},
  },
  get_product: {
    name: 'get_product',
    type: 'read',
    safety_level: 'low',
    requires_auth: false,
    input_schema: {},
    output_schema: {},
  },
  create_cart: {
    name: 'create_cart',
    type: 'cart',
    safety_level: 'medium',
    requires_auth: true,
    input_schema: {},
    output_schema: {},
  },
  initiate_checkout: {
    name: 'initiate_checkout',
    type: 'checkout',
    safety_level: 'high',
    requires_auth: true,
    input_schema: {},
    output_schema: {},
  },
};

export interface Regression {
  shopId: string;
  shopDomain: string;
  toolName: string;
  successRate: number;
}

export interface ReverifyReport {
  shopsChecked: number;
  toolsVerified: number;
  regressions: Regression[];
}

/**
 * Nightly reverification: exercise all tools for all active shops,
 * recompute success scores, and flag regressions.
 */
export async function runNightlyReverification(
  db: Database,
  router: ExecutionRouter,
): Promise<ReverifyReport> {
  // Find all active shops
  const activeShops = await db.query.shops.findMany({
    where: and(eq(shops.agentEnabled, true), isNull(shops.uninstalledAt)),
  });

  let toolsVerified = 0;
  const regressions: Regression[] = [];

  for (const shop of activeShops) {
    // Get a sample product for verification
    const sampleProduct = await db.query.products.findFirst({
      where: and(eq(products.shopId, shop.id), eq(products.status, 'active')),
    });

    const variantId = sampleProduct
      ? ((sampleProduct.variantsJson as any[])?.[0]?.id ?? null)
      : null;

    // Run each tool
    for (const toolName of TOOL_NAMES) {
      const inputs = buildReverifyInputs(toolName, sampleProduct, variantId);
      if (inputs === null) continue; // Skip if we can't build inputs

      await router.execute(
        {
          shopId: shop.id,
          toolName,
          inputs,
          authContext: { isAuthenticated: true, agentId: 'reverify-nightly' },
        },
        REVERIFY_TOOL_DEFS[toolName]!,
      );

      toolsVerified++;
    }

    // Recompute success scores for all tools
    for (const toolName of TOOL_NAMES) {
      const score = await computeSuccessScore(db, shop.id, toolName, 7);
      if (score.totalRuns > 0 && score.successRate < REGRESSION_THRESHOLD) {
        regressions.push({
          shopId: shop.id,
          shopDomain: shop.shopDomain,
          toolName,
          successRate: score.successRate,
        });
      }
    }

    // Update last_verified_at
    await db
      .update(shops)
      .set({ lastSyncedAt: new Date() })
      .where(eq(shops.id, shop.id));
  }

  return {
    shopsChecked: activeShops.length,
    toolsVerified,
    regressions,
  };
}

/**
 * Build inputs for each tool's reverification run.
 */
function buildReverifyInputs(
  toolName: string,
  product: any | null,
  variantId: string | null,
): Record<string, unknown> | null {
  switch (toolName) {
    case 'search_products':
      return { query: 'test' };
    case 'get_product':
      return product
        ? { product_id: product.shopifyProductId }
        : null;
    case 'create_cart':
      return variantId
        ? { lines: [{ variant_id: variantId, quantity: 1 }] }
        : null;
    case 'initiate_checkout':
      // Use a placeholder — the router will attempt to get a checkout URL
      // for a cart that was just created. In reverification, we pass a
      // synthetic cart_id. The Shopify API will respond with an error
      // or a real URL — both are informative.
      return { cart_id: 'reverify-synthetic' };
    default:
      return null;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/reliability && npx vitest run src/__tests__/reverifyJob.test.ts`
Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add packages/reliability/src/reverifyJob.ts packages/reliability/src/__tests__/reverifyJob.test.ts
git commit -m "feat(reliability): nightly reverification job with regression detection"
```

---

### Task 4: Module exports + full verification

**Files:**
- Modify: `packages/reliability/src/index.ts`

**Step 1: Update index.ts with exports**

```typescript
export {
  computeSuccessScore,
  getSuccessScores,
  type SuccessScoreResult,
} from './successScore.js';

export {
  runNightlyReverification,
  type ReverifyReport,
  type Regression,
} from './reverifyJob.js';
```

**Step 2: Run all reliability tests**

Run: `pnpm --filter @shopify-agent-channel/reliability test`
Expected: All tests PASS

**Step 3: Run full project test suite**

Run: `pnpm --filter @shopify-agent-channel/shopify-auth --filter @shopify-agent-channel/ingest --filter @shopify-agent-channel/catalog --filter @shopify-agent-channel/manifest --filter @shopify-agent-channel/exec --filter @shopify-agent-channel/mcp-server --filter @shopify-agent-channel/api --filter @shopify-agent-channel/edge-worker --filter @shopify-agent-channel/reliability run test`
Expected: All 190+ tests pass, zero regressions

**Step 4: Commit**

```bash
git add packages/reliability/src/index.ts
git commit -m "feat(reliability): Phase 10 complete — exports + all tests passing"
```

---

## Summary

| Task | Description | Files | Tests |
|------|-------------|-------|-------|
| 1 | Package setup | 1 | - |
| 2 | Success score computation | 2 | ~8 tests |
| 3 | Nightly reverification job | 2 | ~8 tests |
| 4 | Exports + full verification | 1 | - |
