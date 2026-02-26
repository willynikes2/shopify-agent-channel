import { describe, expect, it, vi, beforeEach } from 'vitest';
import { encryptToken } from '@shopify-agent-channel/shopify-auth';
import { ingestShop } from '../ingestShop.js';
import type { ShopifyClient, ShopifyProduct } from '../shopifyClient.js';

// ---- fixtures ---------------------------------------------------------------

const ENCRYPTION_KEY = 'a'.repeat(64);
process.env['ENCRYPTION_KEY'] = ENCRYPTION_KEY;

const SHOP_ID = '00000000-0000-0000-0000-000000000001';

const MOCK_SHOP = {
  id: SHOP_ID,
  shopDomain: 'test.myshopify.com',
  shopifyAccessTokenEncrypted: encryptToken('shpat_fake_token', ENCRYPTION_KEY),
  shopName: 'Test Shop',
  shopCurrency: 'USD',
  plan: 'starter',
  agentEnabled: true,
  agentHostname: null,
  installedAt: new Date(),
  uninstalledAt: null,
  lastSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  shopifyScopes: 'read_products',
};

function makeProduct(shopifyId: string, variantCount = 1): ShopifyProduct {
  return {
    id: `gid://shopify/Product/${shopifyId}`,
    title: `Product ${shopifyId}`,
    description: null,
    productType: 'Shoes',
    vendor: 'Nike',
    tags: ['shoes'],
    status: 'active',
    updatedAt: null,
    variants: Array.from({ length: variantCount }, (_, i) => ({
      id: `gid://shopify/ProductVariant/${shopifyId}${i}`,
      title: `Variant ${i}`,
      price: '99.00',
      sku: null,
      inventoryQuantity: 10,
      selectedOptions: [],
    })),
    images: [],
  };
}

// ---- mock DB factory --------------------------------------------------------

function makeDb(opts: {
  shop?: object | null;
  existingProducts?: Array<{ id: string; shopifyProductId: string }>;
} = {}) {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });

  return {
    query: {
      shops: { findFirst: vi.fn().mockResolvedValue('shop' in opts ? opts.shop : MOCK_SHOP) },
      products: { findMany: vi.fn().mockResolvedValue(opts.existingProducts ?? []) },
    },
    update: vi.fn().mockReturnValue({ set }),
    insert: vi.fn().mockReturnValue({ values }),
    // exposed for assertions
    _set: set,
    _where: where,
    _onConflictDoUpdate: onConflictDoUpdate,
    _values: values,
  };
}

// ---- mock Shopify client factory --------------------------------------------

function makeClientFactory(pages: ShopifyProduct[][]): (
  domain: string,
  token: string,
) => ShopifyClient {
  let page = 0;
  const fetchProducts = vi.fn().mockImplementation(async () => {
    const products = pages[page] ?? [];
    const hasNextPage = page < pages.length - 1;
    const endCursor = hasNextPage ? `cursor_page_${page + 1}` : null;
    page++;
    return { products, pageInfo: { hasNextPage, endCursor } };
  });
  const fetchShopInfo = vi.fn().mockResolvedValue({
    name: 'Test Shop',
    currency: 'USD',
    domain: 'https://test.com',
    myshopifyDomain: 'test.myshopify.com',
    plan: 'basic',
  });
  return () => ({ fetchShopInfo, fetchProducts, fetchCollections: vi.fn() }) as unknown as ShopifyClient;
}

// ---- tests ------------------------------------------------------------------

describe('ingestShop — upsert', () => {
  it('upserts all products and returns correct productsUpserted count', async () => {
    const db = makeDb();
    const factory = makeClientFactory([[makeProduct('1'), makeProduct('2')]]);

    const result = await ingestShop(SHOP_ID, db as any, factory);

    expect(result.productsUpserted).toBe(2);
    expect(db._values).toHaveBeenCalledTimes(2);
  });

  it('counts total variants across all products', async () => {
    const db = makeDb();
    const factory = makeClientFactory([[makeProduct('1', 1), makeProduct('2', 3)]]);

    const result = await ingestShop(SHOP_ID, db as any, factory);

    expect(result.totalVariants).toBe(4);
  });

  it('upserts product with shopifyProductId as numeric portion of GID', async () => {
    const db = makeDb();
    const factory = makeClientFactory([[makeProduct('9876')]]);

    await ingestShop(SHOP_ID, db as any, factory);

    const insertedValues = db._values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedValues['shopifyProductId']).toBe('9876');
  });
});

describe('ingestShop — pagination', () => {
  it('follows hasNextPage across multiple pages', async () => {
    const db = makeDb();
    const factory = makeClientFactory([
      [makeProduct('1'), makeProduct('2')],
      [makeProduct('3')],
    ]);

    const result = await ingestShop(SHOP_ID, db as any, factory);

    expect(result.productsUpserted).toBe(3);
    expect(db._values).toHaveBeenCalledTimes(3);
  });

  it('stops fetching when hasNextPage is false', async () => {
    const db = makeDb();
    let page = 0;
    const fetchProducts = vi.fn().mockImplementation(async () => {
      page++;
      return {
        products: [makeProduct(String(page))],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    });
    const fetchShopInfo = vi.fn().mockResolvedValue({
      name: 'T', currency: 'USD', domain: '', myshopifyDomain: 'test.myshopify.com', plan: 'basic',
    });
    const factory = () =>
      ({ fetchShopInfo, fetchProducts, fetchCollections: vi.fn() }) as unknown as ShopifyClient;

    await ingestShop(SHOP_ID, db as any, factory);

    expect(fetchProducts).toHaveBeenCalledTimes(1);
  });
});

describe('ingestShop — archive', () => {
  it('archives products present in DB but absent from Shopify', async () => {
    const existingProducts = [
      { id: 'uuid-kept', shopifyProductId: '1' },
      { id: 'uuid-gone', shopifyProductId: '999' }, // not returned by Shopify
    ];
    const db = makeDb({ existingProducts });
    // Shopify only returns product '1'
    const factory = makeClientFactory([[makeProduct('1')]]);

    const result = await ingestShop(SHOP_ID, db as any, factory);

    expect(result.productsArchived).toBe(1);
    const setCalls = db._set.mock.calls as Array<[Record<string, unknown>]>;
    expect(setCalls.some((args) => args[0]?.['status'] === 'archived')).toBe(true);
  });

  it('archives nothing when all DB products are still in Shopify', async () => {
    const existingProducts = [{ id: 'uuid-1', shopifyProductId: '1' }];
    const db = makeDb({ existingProducts });
    const factory = makeClientFactory([[makeProduct('1')]]);

    const result = await ingestShop(SHOP_ID, db as any, factory);

    expect(result.productsArchived).toBe(0);
  });
});

describe('ingestShop — shop updates', () => {
  it('updates shop name and currency from Shopify', async () => {
    const db = makeDb();
    const factory = makeClientFactory([[]]);

    await ingestShop(SHOP_ID, db as any, factory);

    const setCalls = db._set.mock.calls as Array<[Record<string, unknown>]>;
    expect(setCalls.some((args) => 'shopName' in (args[0] ?? {}))).toBe(true);
  });

  it('updates lastSyncedAt after sync completes', async () => {
    const db = makeDb();
    const factory = makeClientFactory([[]]);

    await ingestShop(SHOP_ID, db as any, factory);

    const setCalls = db._set.mock.calls as Array<[Record<string, unknown>]>;
    expect(setCalls.some((args) => 'lastSyncedAt' in (args[0] ?? {}))).toBe(true);
  });
});

describe('ingestShop — error cases', () => {
  it('throws when shop is not found', async () => {
    const db = makeDb({ shop: null });
    const factory = makeClientFactory([]);

    await expect(ingestShop(SHOP_ID, db as any, factory)).rejects.toThrow(
      'Shop not found',
    );
  });
});
