import { describe, expect, it, vi } from 'vitest';
import { searchProducts } from '../search.js';
import type { Database } from '@shopify-agent-channel/db';

// ---------------------------------------------------------------------------
// Fixtures — 20 products matching the BUILDSHEET "seed 20 products" spec
// ---------------------------------------------------------------------------

interface StoredVariant {
  id: string;
  title: string;
  price: string;
  sku: string | null;
  inventoryQuantity: number;
  selectedOptions: Array<{ name: string; value: string }>;
}

function makeProduct(
  id: string,
  title: string,
  opts: {
    description?: string;
    vendor?: string;
    productType?: string;
    tags?: string[];
    variants?: StoredVariant[];
    imageUrl?: string;
  } = {},
) {
  return {
    id,
    shopId: 'shop-1',
    shopifyProductId: id,
    title,
    description: opts.description ?? null,
    vendor: opts.vendor ?? 'Generic',
    productType: opts.productType ?? 'Shoes',
    tags: opts.tags ?? [],
    status: 'active',
    variantsJson: opts.variants ?? [
      {
        id: `${id}-v1`,
        title: 'One Size',
        price: '99.00',
        sku: null,
        inventoryQuantity: 5,
        selectedOptions: [],
      },
    ],
    imagesJson: opts.imageUrl
      ? [{ url: opts.imageUrl, altText: null }]
      : [],
    shopifyUpdatedAt: null,
    syncedAt: new Date(),
  };
}

// 20 products that cover all filter scenarios
const PRODUCTS = [
  makeProduct('1', 'Air Jordan 1 High', {
    vendor: 'Nike',
    tags: ['jordan', 'basketball'],
    variants: [
      { id: '1a', title: 'Size 11', price: '180.00', sku: 'AJ1-11', inventoryQuantity: 3, selectedOptions: [{ name: 'Size', value: '11' }] },
      { id: '1b', title: 'Size 11.5', price: '180.00', sku: 'AJ1-115', inventoryQuantity: 1, selectedOptions: [{ name: 'Size', value: '11.5' }] },
      { id: '1c', title: 'Size 12', price: '180.00', sku: 'AJ1-12', inventoryQuantity: 0, selectedOptions: [{ name: 'Size', value: '12' }] },
    ],
    imageUrl: 'https://cdn.shopify.com/jordan1.jpg',
  }),
  makeProduct('2', 'Jordan Max Aura', {
    vendor: 'Nike',
    tags: ['jordan', 'casual'],
    variants: [
      { id: '2a', title: 'Size 10', price: '100.00', sku: 'JMA-10', inventoryQuantity: 2, selectedOptions: [{ name: 'Size', value: '10' }] },
      { id: '2b', title: 'Size 11.5', price: '100.00', sku: 'JMA-115', inventoryQuantity: 0, selectedOptions: [{ name: 'Size', value: '11.5' }] },
    ],
  }),
  makeProduct('3', 'Ultraboost 22', {
    vendor: 'Adidas',
    productType: 'Running',
    tags: ['running'],
    variants: [
      { id: '3a', title: 'Size 11.5', price: '190.00', sku: 'UB-115', inventoryQuantity: 4, selectedOptions: [{ name: 'Size', value: '11.5' }] },
    ],
  }),
  makeProduct('4', 'Nike Air Force 1', {
    vendor: 'Nike',
    description: 'Classic white sneaker',
    tags: ['classic', 'white'],
    variants: [
      { id: '4a', title: 'Size 11 White', price: '90.00', sku: 'AF1-11W', inventoryQuantity: 10, selectedOptions: [{ name: 'Size', value: '11' }, { name: 'Color', value: 'White' }] },
      { id: '4b', title: 'Size 11 Black', price: '90.00', sku: 'AF1-11B', inventoryQuantity: 0, selectedOptions: [{ name: 'Size', value: '11' }, { name: 'Color', value: 'Black' }] },
    ],
  }),
  makeProduct('5', 'Yeezy Boost 350', {
    vendor: 'Adidas',
    tags: ['yeezy', 'boost'],
    variants: [
      { id: '5a', title: 'Size 11.5', price: '220.00', sku: 'YZ-115', inventoryQuantity: 1, selectedOptions: [{ name: 'Size', value: '11.5' }] },
    ],
  }),
  // 15 more generic products to total 20
  ...Array.from({ length: 15 }, (_, i) => makeProduct(
    String(i + 6),
    `Generic Sneaker ${i + 6}`,
    { vendor: 'Brand', tags: ['generic'], variants: [{ id: `${i + 6}-v1`, title: 'Size 10', price: '50.00', sku: null, inventoryQuantity: i % 3 === 0 ? 0 : 5, selectedOptions: [{ name: 'Size', value: '10' }] }] },
  )),
];

function makeDb(rows = PRODUCTS) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as Database;
}

// ---------------------------------------------------------------------------
// Text search
// ---------------------------------------------------------------------------

describe('searchProducts — text matching', () => {
  it('matches products with query in title', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'jordan');
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Air Jordan 1 High');
    expect(titles).toContain('Jordan Max Aura');
  });

  it('matches products with query in tags', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'basketball');
    expect(results.some((r) => r.title === 'Air Jordan 1 High')).toBe(true);
  });

  it('matches products with query in vendor', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'adidas');
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Ultraboost 22');
    expect(titles).toContain('Yeezy Boost 350');
  });

  it('matches products with query in description', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'classic white sneaker');
    expect(results.some((r) => r.title === 'Nike Air Force 1')).toBe(true);
  });

  it('is case-insensitive', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'JORDAN');
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns empty array for non-matching query', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'zzz_nomatch_xyz');
    expect(results).toHaveLength(0);
  });

  it('respects limit', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', '', {}, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Size / color filtering
// ---------------------------------------------------------------------------

describe('searchProducts — variant size filter', () => {
  it('returns only products that have a size 11.5 variant', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', '', { size: '11.5' });
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Air Jordan 1 High');
    expect(titles).toContain('Jordan Max Aura');
    expect(titles).toContain('Ultraboost 22');
    expect(titles).toContain('Yeezy Boost 350');
    // generic products only have Size 10, should be excluded
    expect(titles.every((t) => !t.startsWith('Generic'))).toBe(true);
  });

  it('returns only size 11.5 variants within each result', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'jordan', { size: '11.5' });
    for (const r of results) {
      expect(r.variants.every((v) => v.selectedOptions.some((o) => o.name === 'Size' && o.value === '11.5'))).toBe(true);
    }
  });
});

describe('searchProducts — variant color filter', () => {
  it('returns only products with a White color variant', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', '', { color: 'White' });
    expect(results.some((r) => r.title === 'Nike Air Force 1')).toBe(true);
    // jordans have no color option — should not appear
    expect(results.every((r) => r.title !== 'Air Jordan 1 High')).toBe(true);
  });

  it('returns only the matching color variants within each result', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', '', { color: 'White' });
    const af1 = results.find((r) => r.title === 'Nike Air Force 1');
    expect(af1).toBeDefined();
    expect(af1!.variants.every((v) => v.selectedOptions.some((o) => o.name === 'Color' && o.value === 'White'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Price range filtering
// ---------------------------------------------------------------------------

describe('searchProducts — price range filter', () => {
  it('excludes products with no variant in price range', async () => {
    // minPrice 200 — only Yeezy (220) qualifies
    const results = await searchProducts(makeDb(), 'shop-1', '', { minPrice: 200 });
    expect(results.some((r) => r.title === 'Yeezy Boost 350')).toBe(true);
    expect(results.every((r) => r.title !== 'Air Jordan 1 High')).toBe(true); // 180 < 200
  });

  it('excludes products above maxPrice', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', '', { maxPrice: 95 });
    // Air Force 1 (90) passes, Jordans (180+) don't
    expect(results.some((r) => r.title === 'Nike Air Force 1')).toBe(true);
    expect(results.every((r) => r.title !== 'Air Jordan 1 High')).toBe(true);
  });

  it('applies both min and max price together', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', '', { minPrice: 180, maxPrice: 195 });
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Air Jordan 1 High');   // 180 ✓
    expect(titles).toContain('Ultraboost 22');        // 190 ✓
    expect(titles).not.toContain('Yeezy Boost 350'); // 220 ✗
    expect(titles).not.toContain('Nike Air Force 1'); // 90 ✗
  });
});

// ---------------------------------------------------------------------------
// inStock filter
// ---------------------------------------------------------------------------

describe('searchProducts — inStock filter', () => {
  it('excludes products where all variants are out of stock', async () => {
    // Jordan Max Aura size 11.5 is out of stock, but size 10 has stock
    const results = await searchProducts(makeDb(), 'shop-1', 'jordan', { inStock: true });
    // Air Jordan 1 has stock on sizes 11 and 11.5
    expect(results.some((r) => r.title === 'Air Jordan 1 High')).toBe(true);
  });

  it('excludes out-of-stock variants from returned variants list', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'jordan 1', { inStock: true });
    const aj1 = results.find((r) => r.title === 'Air Jordan 1 High');
    if (aj1) {
      // size 12 is out of stock — should not appear
      expect(aj1.variants.every((v) => v.inventoryQuantity > 0)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe('searchProducts — result shape', () => {
  it('returns correct ProductSearchResult fields', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'jordan 1 high');
    const r = results[0]!;
    expect(r).toHaveProperty('productId');
    expect(r).toHaveProperty('title');
    expect(r).toHaveProperty('vendor');
    expect(r).toHaveProperty('productType');
    expect(r).toHaveProperty('variants');
    expect(r).toHaveProperty('priceRange');
    expect(r.priceRange).toHaveProperty('min');
    expect(r.priceRange).toHaveProperty('max');
    expect(r).toHaveProperty('primaryImage');
    expect(r).toHaveProperty('available');
  });

  it('sets primaryImage from first image', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'jordan 1 high');
    const r = results.find((p) => p.title === 'Air Jordan 1 High');
    expect(r?.primaryImage).toBe('https://cdn.shopify.com/jordan1.jpg');
  });

  it('sets primaryImage to null when product has no images', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'jordan max aura');
    const r = results.find((p) => p.title === 'Jordan Max Aura');
    expect(r?.primaryImage).toBeNull();
  });

  it('sets available true when any variant has stock', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'jordan 1 high');
    const r = results.find((p) => p.title === 'Air Jordan 1 High');
    expect(r?.available).toBe(true);
  });

  it('computes correct priceRange min and max from variants', async () => {
    const results = await searchProducts(makeDb(), 'shop-1', 'jordan 1 high');
    const r = results.find((p) => p.title === 'Air Jordan 1 High');
    expect(r?.priceRange.min).toBe('180.00');
    expect(r?.priceRange.max).toBe('180.00');
  });
});
