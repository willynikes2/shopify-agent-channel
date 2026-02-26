import { and, eq } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { products } from '@shopify-agent-channel/db';

export interface SearchFilters {
  productType?: string;
  vendor?: string;
  minPrice?: number;
  maxPrice?: number;
  size?: string;
  color?: string;
  inStock?: boolean;
}

export interface VariantResult {
  id: string;
  title: string;
  price: string;
  sku: string | null;
  inventoryQuantity: number;
  selectedOptions: Array<{ name: string; value: string }>;
}

export interface ProductSearchResult {
  productId: string;
  title: string;
  description: string | null;
  vendor: string | null;
  productType: string | null;
  variants: VariantResult[];
  priceRange: { min: string; max: string };
  primaryImage: string | null;
  available: boolean;
}

interface StoredVariant {
  id: string;
  title: string;
  price: string;
  sku: string | null;
  inventoryQuantity: number;
  selectedOptions: Array<{ name: string; value: string }>;
}

interface StoredImage {
  url: string;
  altText: string | null;
}

export async function searchProducts(
  db: Database,
  shopId: string,
  query: string,
  filters: SearchFilters = {},
  limit = 20,
): Promise<ProductSearchResult[]> {
  // Fetch all active products for shop from DB
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.shopId, shopId), eq(products.status, 'active')));

  const q = query.toLowerCase();

  const results: ProductSearchResult[] = [];

  for (const row of rows) {
    // Text search (v1: in-memory ILIKE equivalent)
    if (q) {
      const searchable = [
        row.title,
        row.description,
        row.vendor,
        row.productType,
        ...(row.tags ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!searchable.includes(q)) continue;
    }

    // Product-level filters
    if (filters.productType && row.productType?.toLowerCase() !== filters.productType.toLowerCase()) continue;
    if (filters.vendor && row.vendor?.toLowerCase() !== filters.vendor.toLowerCase()) continue;

    // Apply variant-level filters
    const allVariants = (row.variantsJson as StoredVariant[] | null) ?? [];
    const matchedVariants = allVariants.filter((v) => variantMatches(v, filters));

    // No variants pass the filter → skip this product
    if (filters.size || filters.color || filters.minPrice !== undefined || filters.maxPrice !== undefined || filters.inStock) {
      if (matchedVariants.length === 0) continue;
    }

    const displayVariants = (filters.size || filters.color || filters.minPrice !== undefined || filters.maxPrice !== undefined || filters.inStock)
      ? matchedVariants
      : allVariants;

    const images = (row.imagesJson as StoredImage[] | null) ?? [];
    const prices = displayVariants.map((v) => parseFloat(v.price)).filter(Number.isFinite);
    const minPrice = prices.length ? Math.min(...prices).toFixed(2) : '0.00';
    const maxPrice = prices.length ? Math.max(...prices).toFixed(2) : '0.00';

    results.push({
      productId: row.shopifyProductId,
      title: row.title,
      description: row.description ?? null,
      vendor: row.vendor ?? null,
      productType: row.productType ?? null,
      variants: displayVariants,
      priceRange: { min: minPrice, max: maxPrice },
      primaryImage: images[0]?.url ?? null,
      available: allVariants.some((v) => v.inventoryQuantity > 0),
    });

    if (results.length >= limit) break;
  }

  return results;
}

function variantMatches(variant: StoredVariant, filters: SearchFilters): boolean {
  if (filters.size) {
    const opt = variant.selectedOptions.find((o) => o.name.toLowerCase() === 'size');
    if (!opt || opt.value.toLowerCase() !== filters.size.toLowerCase()) return false;
  }
  if (filters.color) {
    const opt = variant.selectedOptions.find((o) => o.name.toLowerCase() === 'color');
    if (!opt || opt.value.toLowerCase() !== filters.color.toLowerCase()) return false;
  }
  if (filters.minPrice !== undefined && parseFloat(variant.price) < filters.minPrice) return false;
  if (filters.maxPrice !== undefined && parseFloat(variant.price) > filters.maxPrice) return false;
  if (filters.inStock && variant.inventoryQuantity <= 0) return false;
  return true;
}
