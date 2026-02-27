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
      return { cart_id: 'reverify-synthetic' };
    default:
      return null;
  }
}
