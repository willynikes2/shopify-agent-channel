import { eq } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { shops, products } from '@shopify-agent-channel/db';

export async function handleAppUninstalled(
  shopDomain: string,
  db: Database,
): Promise<void> {
  await db
    .update(shops)
    .set({ uninstalledAt: new Date(), agentEnabled: false, updatedAt: new Date() })
    .where(eq(shops.shopDomain, shopDomain));
}

export async function handleProductsUpdate(
  shopDomain: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  product: any,
  db: Database,
): Promise<void> {
  const shop = await db.query.shops.findFirst({
    where: eq(shops.shopDomain, shopDomain),
  });
  if (!shop) return;

  await db
    .insert(products)
    .values({
      shopId: shop.id,
      shopifyProductId: String(product.id),
      title: product.title ?? '',
      description: product.body_html ?? null,
      productType: product.product_type ?? null,
      vendor: product.vendor ?? null,
      tags: product.tags ? String(product.tags).split(', ').filter(Boolean) : [],
      status: product.status ?? 'active',
      variantsJson: product.variants ?? [],
      imagesJson: product.images ?? [],
      shopifyUpdatedAt: product.updated_at ? new Date(product.updated_at) : null,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [products.shopId, products.shopifyProductId],
      set: {
        title: product.title ?? '',
        description: product.body_html ?? null,
        productType: product.product_type ?? null,
        vendor: product.vendor ?? null,
        tags: product.tags ? String(product.tags).split(', ').filter(Boolean) : [],
        status: product.status ?? 'active',
        variantsJson: product.variants ?? [],
        imagesJson: product.images ?? [],
        shopifyUpdatedAt: product.updated_at ? new Date(product.updated_at) : null,
        syncedAt: new Date(),
      },
    });
}
