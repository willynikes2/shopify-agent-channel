import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShopifyClient } from '../shopifyClient.js';

function stubFetch(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data }),
  });
}

describe('ShopifyClient.fetchShopInfo', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns correctly shaped shop info', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        shop: {
          name: 'Cool Kicks',
          currencyCode: 'USD',
          myshopifyDomain: 'cool-kicks.myshopify.com',
          primaryDomain: { url: 'https://cool-kicks.com' },
          plan: { displayName: 'Basic' },
        },
      }),
    );

    const client = new ShopifyClient('cool-kicks.myshopify.com', 'token123');
    const info = await client.fetchShopInfo();

    expect(info.name).toBe('Cool Kicks');
    expect(info.currency).toBe('USD');
    expect(info.myshopifyDomain).toBe('cool-kicks.myshopify.com');
    expect(info.plan).toBe('Basic');
  });

  it('throws on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const client = new ShopifyClient('cool-kicks.myshopify.com', 'bad-token');
    await expect(client.fetchShopInfo()).rejects.toThrow('401');
  });

  it('throws on GraphQL errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ errors: [{ message: 'Access denied' }], data: null }),
      }),
    );

    const client = new ShopifyClient('cool-kicks.myshopify.com', 'token');
    await expect(client.fetchShopInfo()).rejects.toThrow('Access denied');
  });
});

describe('ShopifyClient.fetchProducts', () => {
  afterEach(() => vi.unstubAllGlobals());

  const makeProductNode = (id: string) => ({
    id: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    description: `Desc ${id}`,
    productType: 'Shoes',
    vendor: 'Nike',
    tags: ['shoes', 'sport'],
    status: 'ACTIVE',
    updatedAt: '2024-01-15T00:00:00Z',
    variants: {
      edges: [
        {
          node: {
            id: `gid://shopify/ProductVariant/${id}1`,
            title: 'Size 11',
            price: '120.00',
            sku: `SKU-${id}`,
            inventoryQuantity: 5,
            selectedOptions: [{ name: 'Size', value: '11' }],
          },
        },
      ],
    },
    images: {
      edges: [{ node: { url: 'https://cdn.shopify.com/img.jpg', altText: 'A shoe' } }],
    },
  });

  it('returns products and pageInfo', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        products: {
          edges: [{ node: makeProductNode('1') }, { node: makeProductNode('2') }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    );

    const client = new ShopifyClient('cool-kicks.myshopify.com', 'token');
    const result = await client.fetchProducts();

    expect(result.products).toHaveLength(2);
    expect(result.products[0]!.title).toBe('Product 1');
    expect(result.products[0]!.variants).toHaveLength(1);
    expect(result.products[0]!.images).toHaveLength(1);
    expect(result.pageInfo.hasNextPage).toBe(false);
  });

  it('lowercases product status', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        products: {
          edges: [{ node: makeProductNode('1') }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    );

    const client = new ShopifyClient('cool-kicks.myshopify.com', 'token');
    const { products } = await client.fetchProducts();
    expect(products[0]!.status).toBe('active');
  });

  it('passes cursor as variable when provided', async () => {
    const fetchMock = stubFetch({
      products: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new ShopifyClient('cool-kicks.myshopify.com', 'token');
    await client.fetchProducts('cursor_abc');

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.variables.after).toBe('cursor_abc');
  });

  it('passes null cursor when not provided', async () => {
    const fetchMock = stubFetch({
      products: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new ShopifyClient('cool-kicks.myshopify.com', 'token');
    await client.fetchProducts();

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.variables.after).toBeNull();
  });
});

describe('ShopifyClient.fetchCollections', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns collections and pageInfo', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        collections: {
          edges: [
            {
              node: {
                id: 'gid://shopify/Collection/1',
                title: 'Sneakers',
                handle: 'sneakers',
                description: 'All sneakers',
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    );

    const client = new ShopifyClient('cool-kicks.myshopify.com', 'token');
    const result = await client.fetchCollections();

    expect(result.collections).toHaveLength(1);
    expect(result.collections[0]!.title).toBe('Sneakers');
    expect(result.collections[0]!.handle).toBe('sneakers');
    expect(result.pageInfo.hasNextPage).toBe(false);
  });
});
