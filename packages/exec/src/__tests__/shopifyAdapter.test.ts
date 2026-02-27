import { describe, expect, it, vi } from 'vitest';
import { encryptToken } from '@shopify-agent-channel/shopify-auth';
import { ShopifyAdapter } from '../adapters/shopify.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY = 'a'.repeat(64);
process.env['ENCRYPTION_KEY'] = ENCRYPTION_KEY;

const SHOP_ID = '00000000-0000-0000-0000-000000000001';

const MOCK_SHOP = {
  id: SHOP_ID,
  shopDomain: 'test.myshopify.com',
  shopifyAccessTokenEncrypted: encryptToken('shpat_fake_token', ENCRYPTION_KEY),
  shopName: 'Test Shop',
  shopCurrency: 'USD',
};

const MOCK_PRODUCT = {
  id: 'prod-uuid-1',
  shopId: SHOP_ID,
  shopifyProductId: 'gid://shopify/Product/123',
  title: 'Air Max 90',
  description: 'Classic sneaker',
  productType: 'Shoes',
  vendor: 'Nike',
  tags: ['shoes', 'classic'],
  status: 'active',
  variantsJson: [{ id: 'gid://shopify/ProductVariant/456', title: 'Size 11', price: '129.99' }],
  imagesJson: [],
};

function makeDb(opts: { shop?: object | null; product?: object | null } = {}) {
  return {
    query: {
      shops: {
        findFirst: vi.fn().mockResolvedValue('shop' in opts ? opts.shop : MOCK_SHOP),
      },
      products: {
        findFirst: vi.fn().mockResolvedValue('product' in opts ? opts.product : MOCK_PRODUCT),
      },
    },
  };
}

function makeStorefrontFactory(opts: { cartCreate?: object; getCart?: object } = {}) {
  const cartCreate = vi.fn().mockResolvedValue(opts.cartCreate ?? {});
  const getCart = vi.fn().mockResolvedValue(opts.getCart ?? {});
  const factory = vi.fn().mockReturnValue({ cartCreate, getCart });
  return { factory, cartCreate, getCart };
}

// ---------------------------------------------------------------------------
// Mock catalog
// ---------------------------------------------------------------------------

vi.mock('@shopify-agent-channel/catalog', () => ({
  searchProducts: vi.fn(),
}));

import { searchProducts } from '@shopify-agent-channel/catalog';

// ---------------------------------------------------------------------------
// search_products
// ---------------------------------------------------------------------------

describe('ShopifyAdapter — search_products', () => {
  it('calls searchProducts with correct args and returns results', async () => {
    vi.mocked(searchProducts).mockResolvedValueOnce([{ productId: 'p1' } as any]);
    const db = makeDb();
    const adapter = new ShopifyAdapter(db as any);

    const result = await adapter.execute(SHOP_ID, 'search_products', {
      query: 'shoes',
      filters: { inStock: true },
    });

    expect(searchProducts).toHaveBeenCalledWith(db, SHOP_ID, 'shoes', { inStock: true }, 20);
    expect(result.status).toBe('success');
    expect((result.data as any).totalFound).toBe(1);
    expect((result.data as any).results).toHaveLength(1);
  });

  it('uses default empty filters when not provided', async () => {
    vi.mocked(searchProducts).mockResolvedValueOnce([]);
    const db = makeDb();
    const adapter = new ShopifyAdapter(db as any);

    await adapter.execute(SHOP_ID, 'search_products', { query: 'hats' });

    expect(searchProducts).toHaveBeenCalledWith(db, SHOP_ID, 'hats', {}, 20);
  });
});

// ---------------------------------------------------------------------------
// get_product
// ---------------------------------------------------------------------------

describe('ShopifyAdapter — get_product', () => {
  it('returns product from DB', async () => {
    const db = makeDb({ product: MOCK_PRODUCT });
    const adapter = new ShopifyAdapter(db as any);

    const result = await adapter.execute(SHOP_ID, 'get_product', {
      product_id: 'gid://shopify/Product/123',
    });

    expect(result.status).toBe('success');
    expect((result.data as any).product).toBe(MOCK_PRODUCT);
  });

  it('returns error when product not found', async () => {
    const db = makeDb({ product: null });
    const adapter = new ShopifyAdapter(db as any);

    const result = await adapter.execute(SHOP_ID, 'get_product', { product_id: 'nonexistent' });

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// create_cart
// ---------------------------------------------------------------------------

describe('ShopifyAdapter — create_cart', () => {
  it('calls storefrontFactory with shopDomain and returns cart shape', async () => {
    const mockCart = {
      id: 'gid://shopify/Cart/abc123',
      checkoutUrl: 'https://test.myshopify.com/cart/c/abc123',
      lines: [{ id: 'line-1', quantity: 1, title: 'Air Max 90 / Size 11', price: '129.99' }],
      subtotal: '129.99',
      currency: 'USD',
    };
    const { factory, cartCreate } = makeStorefrontFactory({ cartCreate: mockCart });
    const db = makeDb();
    const adapter = new ShopifyAdapter(db as any, factory);

    const result = await adapter.execute(SHOP_ID, 'create_cart', {
      lines: [{ variant_id: 'gid://shopify/ProductVariant/456', quantity: 1 }],
    });

    expect(cartCreate).toHaveBeenCalledWith([
      { merchandiseId: 'gid://shopify/ProductVariant/456', quantity: 1 },
    ]);
    expect(result.status).toBe('success');
    expect((result.data as any).cart_id).toBe('gid://shopify/Cart/abc123');
    expect((result.data as any).lines).toBeDefined();
    expect((result.data as any).subtotal).toBeDefined();
  });

  it('initialises storefront client with shop domain', async () => {
    const mockCart = { id: 'gid://shopify/Cart/xyz', checkoutUrl: 'https://test.myshopify.com/cart/c/xyz', lines: [], subtotal: '0.00', currency: 'USD' };
    const { factory } = makeStorefrontFactory({ cartCreate: mockCart });
    const db = makeDb();
    const adapter = new ShopifyAdapter(db as any, factory);

    await adapter.execute(SHOP_ID, 'create_cart', { lines: [] });

    expect(factory).toHaveBeenCalledWith('test.myshopify.com', expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// initiate_checkout
// ---------------------------------------------------------------------------

describe('ShopifyAdapter — initiate_checkout', () => {
  it('retrieves cart and returns checkout_url', async () => {
    const { factory } = makeStorefrontFactory({
      getCart: {
        id: 'gid://shopify/Cart/abc123',
        checkoutUrl: 'https://test.myshopify.com/checkouts/cn/abc123',
      },
    });
    const db = makeDb();
    const adapter = new ShopifyAdapter(db as any, factory);

    const result = await adapter.execute(SHOP_ID, 'initiate_checkout', {
      cart_id: 'gid://shopify/Cart/abc123',
    });

    expect(result.status).toBe('success');
    expect((result.data as any).checkout_url).toContain('https://');
  });

  it('returns error when shop not found', async () => {
    const db = makeDb({ shop: null });
    const adapter = new ShopifyAdapter(db as any);

    const result = await adapter.execute(SHOP_ID, 'initiate_checkout', {
      cart_id: 'gid://shopify/Cart/abc123',
    });

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('SHOP_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Unknown tool
// ---------------------------------------------------------------------------

describe('ShopifyAdapter — unknown tool', () => {
  it('returns error for unrecognised toolName', async () => {
    const db = makeDb();
    const adapter = new ShopifyAdapter(db as any);

    const result = await adapter.execute(SHOP_ID, 'nonexistent_tool', {});

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('UNKNOWN_TOOL');
  });
});
