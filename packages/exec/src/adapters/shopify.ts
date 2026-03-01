import { and, eq } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { products, shops } from '@shopify-agent-channel/db';
import { searchProducts } from '@shopify-agent-channel/catalog';
import type { SearchFilters } from '@shopify-agent-channel/catalog';
import { decryptToken, validateEncryptionKey } from '@shopify-agent-channel/shopify-auth';
import { StorefrontClient } from './storefrontClient.js';
import type { ExecResult } from '../types.js';

export class ShopifyAdapter {
  constructor(
    private readonly db: Database,
    private readonly storefrontFactory: (
      shopDomain: string,
      token: string,
    ) => StorefrontClient = (d, t) => new StorefrontClient(d, t),
  ) {}

  async execute(
    shopId: string,
    toolName: string,
    inputs: Record<string, unknown>,
  ): Promise<ExecResult> {
    switch (toolName) {
      case 'search_products':
        return this.searchProducts(shopId, inputs);
      case 'get_product':
        return this.getProduct(shopId, inputs);
      case 'create_cart':
        return this.createCart(shopId, inputs);
      case 'initiate_checkout':
        return this.initiateCheckout(shopId, inputs);
      default:
        return {
          status: 'error',
          error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}` },
          latencyMs: 0,
        };
    }
  }

  private async searchProducts(
    shopId: string,
    inputs: Record<string, unknown>,
  ): Promise<ExecResult> {
    const query = (inputs['query'] as string) ?? '';
    const filters = (inputs['filters'] as SearchFilters) ?? {};
    const limit = (inputs['limit'] as number | undefined) ?? 20;
    const results = await searchProducts(this.db, shopId, query, filters, limit);
    return {
      status: 'success',
      data: { results, totalFound: results.length },
      latencyMs: 0,
    };
  }

  private async getProduct(shopId: string, inputs: Record<string, unknown>): Promise<ExecResult> {
    const productId = inputs['product_id'] as string;
    const product = await this.db.query.products.findFirst({
      where: and(eq(products.shopId, shopId), eq(products.shopifyProductId, productId)),
    });
    if (!product) {
      return {
        status: 'error',
        error: { code: 'NOT_FOUND', message: `Product ${productId} not found` },
        latencyMs: 0,
      };
    }
    return { status: 'success', data: { product }, latencyMs: 0 };
  }

  private async createCart(shopId: string, inputs: Record<string, unknown>): Promise<ExecResult> {
    const shop = await this.loadShop(shopId);
    if (!shop) {
      return {
        status: 'error',
        error: { code: 'SHOP_NOT_FOUND', message: 'Shop not found' },
        latencyMs: 0,
      };
    }
    const token = decryptToken(
      shop.shopifyAccessTokenEncrypted,
      this.getEncryptionKey(),
    );
    const storefront = this.storefrontFactory(shop.shopDomain, token);
    const lines = (inputs['lines'] as Array<{ variant_id: string; quantity: number }>) ?? [];
    const cart = await storefront.cartCreate(
      lines.map((l) => ({ merchandiseId: l.variant_id, quantity: l.quantity })),
    );
    return {
      status: 'success',
      data: {
        cart_id: cart.id,
        lines: cart.lines,
        subtotal: cart.subtotal,
        currency: cart.currency,
        checkout_url: cart.checkoutUrl,
      },
      latencyMs: 0,
    };
  }

  private async initiateCheckout(
    shopId: string,
    inputs: Record<string, unknown>,
  ): Promise<ExecResult> {
    const shop = await this.loadShop(shopId);
    if (!shop) {
      return {
        status: 'error',
        error: { code: 'SHOP_NOT_FOUND', message: 'Shop not found' },
        latencyMs: 0,
      };
    }
    const token = decryptToken(
      shop.shopifyAccessTokenEncrypted,
      this.getEncryptionKey(),
    );
    const storefront = this.storefrontFactory(shop.shopDomain, token);
    const cartId = inputs['cart_id'] as string;
    const cart = await storefront.getCart(cartId);
    return {
      status: 'success',
      data: { checkout_url: cart.checkoutUrl },
      latencyMs: 0,
    };
  }

  private getEncryptionKey(): string {
    const key = process.env['ENCRYPTION_KEY'] ?? '';
    validateEncryptionKey(key);
    return key;
  }

  private async loadShop(shopId: string) {
    return this.db.query.shops.findFirst({
      where: eq(shops.id, shopId),
    });
  }
}
