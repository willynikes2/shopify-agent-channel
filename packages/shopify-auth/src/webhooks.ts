import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@shopify-agent-channel/db';
import { shops, products } from '@shopify-agent-channel/db';

const WebhookProductSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().optional().default(''),
  body_html: z.string().nullable().optional(),
  product_type: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  tags: z.string().optional().default(''),
  status: z.string().optional().default('active'),
  variants: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  images: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  updated_at: z.string().nullable().optional(),
});

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
  rawPayload: unknown,
  db: Database,
): Promise<void> {
  const parsed = WebhookProductSchema.safeParse(rawPayload);
  if (!parsed.success) {
    console.warn(`[webhook] invalid products/update payload from ${shopDomain}:`, parsed.error.message);
    return;
  }
  const product = parsed.data;

  const shop = await db.query.shops.findFirst({
    where: eq(shops.shopDomain, shopDomain),
  });
  if (!shop) return;

  await db
    .insert(products)
    .values({
      shopId: shop.id,
      shopifyProductId: String(product.id),
      title: product.title,
      description: product.body_html ?? null,
      productType: product.product_type ?? null,
      vendor: product.vendor ?? null,
      tags: product.tags ? String(product.tags).split(', ').filter(Boolean) : [],
      status: product.status,
      variantsJson: product.variants,
      imagesJson: product.images,
      shopifyUpdatedAt: product.updated_at ? new Date(product.updated_at) : null,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [products.shopId, products.shopifyProductId],
      set: {
        title: product.title,
        description: product.body_html ?? null,
        productType: product.product_type ?? null,
        vendor: product.vendor ?? null,
        tags: product.tags ? String(product.tags).split(', ').filter(Boolean) : [],
        status: product.status,
        variantsJson: product.variants,
        imagesJson: product.images,
        shopifyUpdatedAt: product.updated_at ? new Date(product.updated_at) : null,
        syncedAt: new Date(),
      },
    });
}
