import { and, eq, ne } from 'drizzle-orm';
import { decryptToken } from '@shopify-agent-channel/shopify-auth';
import type { Database } from '@shopify-agent-channel/db';
import { shops, products } from '@shopify-agent-channel/db';
import { ShopifyClient } from './shopifyClient.js';
import type { ShopifyProduct } from './shopifyClient.js';

export interface IngestResult {
  productsUpserted: number;
  productsArchived: number;
  totalVariants: number;
}

export async function ingestShop(
  shopId: string,
  db: Database,
  clientFactory: (domain: string, token: string) => ShopifyClient = (d, t) =>
    new ShopifyClient(d, t),
): Promise<IngestResult> {
  // 1. Load shop
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw new Error(`Shop not found: ${shopId}`);

  // 2. Decrypt access token
  const encKey = process.env['ENCRYPTION_KEY'] ?? '';
  const accessToken = decryptToken(shop.shopifyAccessTokenEncrypted, encKey);

  // 3. Build client
  const client = clientFactory(shop.shopDomain, accessToken);

  // 4. Fetch shop info and update shop record
  const shopInfo = await client.fetchShopInfo();
  await db
    .update(shops)
    .set({ shopName: shopInfo.name, shopCurrency: shopInfo.currency, updatedAt: new Date() })
    .where(eq(shops.id, shopId));

  // 5. Paginate all products from Shopify
  const seenIds = new Set<string>();
  let cursor: string | undefined;
  let productsUpserted = 0;
  let totalVariants = 0;

  do {
    const { products: page, pageInfo } = await client.fetchProducts(cursor);
    for (const product of page) {
      await upsertProduct(db, shopId, product);
      const numericId = extractNumericId(product.id);
      seenIds.add(numericId);
      productsUpserted++;
      totalVariants += product.variants.length;
    }
    cursor = pageInfo.hasNextPage && pageInfo.endCursor ? pageInfo.endCursor : undefined;
  } while (cursor);

  // 6. Archive products not seen in this sync
  const existingActive = (await db.query.products.findMany({
    where: and(eq(products.shopId, shopId), ne(products.status, 'archived')),
    columns: { id: true, shopifyProductId: true },
  })) as Array<{ id: string; shopifyProductId: string }>;

  let productsArchived = 0;
  for (const p of existingActive) {
    if (!seenIds.has(p.shopifyProductId)) {
      await db.update(products).set({ status: 'archived' }).where(eq(products.id, p.id));
      productsArchived++;
    }
  }

  // 7. Update lastSyncedAt
  await db
    .update(shops)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(shops.id, shopId));

  return { productsUpserted, productsArchived, totalVariants };
}

function extractNumericId(gid: string): string {
  return gid.split('/').pop() ?? gid;
}

async function upsertProduct(
  db: Database,
  shopId: string,
  product: ShopifyProduct,
): Promise<void> {
  const numericId = extractNumericId(product.id);
  const values = {
    shopId,
    shopifyProductId: numericId,
    title: product.title,
    description: product.description,
    productType: product.productType,
    vendor: product.vendor,
    tags: product.tags,
    status: product.status,
    variantsJson: product.variants,
    imagesJson: product.images,
    shopifyUpdatedAt: product.updatedAt ? new Date(product.updatedAt) : null,
    syncedAt: new Date(),
  };
  await db
    .insert(products)
    .values(values)
    .onConflictDoUpdate({
      target: [products.shopId, products.shopifyProductId],
      set: {
        title: values.title,
        description: values.description,
        productType: values.productType,
        vendor: values.vendor,
        tags: values.tags,
        status: values.status,
        variantsJson: values.variantsJson,
        imagesJson: values.imagesJson,
        shopifyUpdatedAt: values.shopifyUpdatedAt,
        syncedAt: values.syncedAt,
      },
    });
}
