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

  it('chains create_cart cart_id into initiate_checkout', async () => {
    const db = makeDb();
    const router = makeRouter();
    await runNightlyReverification(db as any, router as any);
    const checkoutCall = router.execute.mock.calls.find((c: any) => c[0].toolName === 'initiate_checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall![0].inputs.cart_id).toBe('cart-1');
  });

  it('returns toolsVerified count (4 per shop)', async () => {
    const db = makeDb();
    const router = makeRouter();
    const report = await runNightlyReverification(db as any, router as any);
    expect(report.toolsVerified).toBe(4);
  });

  it('detects regressions when a tool has < 80% success rate', async () => {
    const db = makeDb();
    const router = makeRouter();
    let callCount = 0;
    router.execute.mockImplementation(() => {
      callCount++;
      // First call (search_products) fails
      if (callCount === 1) {
        return Promise.resolve({ status: 'error', error: { code: 'FAIL', message: 'fail' }, latencyMs: 50 });
      }
      // create_cart returns cart_id so initiate_checkout can chain
      return Promise.resolve({ status: 'success', data: { cart_id: 'cart-1' }, latencyMs: 50 });
    });

    // Seed tool_runs that show poor history for search_products
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

  it('only runs search_products when shop has no products', async () => {
    const db = makeDb([SHOP_1], []);
    db.query.products.findFirst.mockResolvedValue(null);
    const router = makeRouter();
    const report = await runNightlyReverification(db as any, router as any);
    expect(report.shopsChecked).toBe(1);
    // Only search_products runs — no product means no get_product/create_cart,
    // no cart means no initiate_checkout
    expect(router.execute).toHaveBeenCalledTimes(1);
    expect(router.execute.mock.calls[0][0].toolName).toBe('search_products');
  });

  it('handles multiple shops', async () => {
    const shop2 = { ...SHOP_1, id: 'shop-uuid-2', shopDomain: 'sneaker-store.myshopify.com' };
    const db = makeDb([SHOP_1, shop2]);
    const router = makeRouter();
    const report = await runNightlyReverification(db as any, router as any);
    expect(report.shopsChecked).toBe(2);
    expect(report.toolsVerified).toBe(8); // 4 tools × 2 shops
  });

  it('updates shop.lastVerifiedAt (calls db.update)', async () => {
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

  it('continues to remaining shops when router.execute throws', async () => {
    const shop2 = { ...SHOP_1, id: 'shop-uuid-2', shopDomain: 'other.myshopify.com' };
    const db = makeDb([SHOP_1, shop2]);
    const router = makeRouter();
    let callCount = 0;
    router.execute.mockImplementation(() => {
      callCount++;
      // First call throws
      if (callCount === 1) return Promise.reject(new Error('network timeout'));
      return Promise.resolve({ status: 'success', data: { cart_id: 'cart-1' }, latencyMs: 50 });
    });
    const report = await runNightlyReverification(db as any, router as any);
    expect(report.shopsChecked).toBe(2); // both shops processed
  });
});
