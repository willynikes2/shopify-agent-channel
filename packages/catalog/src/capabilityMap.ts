export interface Capability {
  id: string;
  type: string;
  safety: 'low' | 'medium' | 'high';
  requiresAuth: boolean;
  requiresConfirmation?: boolean;
}

export interface CapabilityMapMetadata {
  shopName: string | null;
  currency: string;
  productCount: number;
  lastSynced: Date | null;
}

export interface CapabilityMap {
  capabilities: Capability[];
  metadata: CapabilityMapMetadata;
}

export interface ToolDefinition {
  name: string;
  type: string;
  safety_level: 'low' | 'medium' | 'high';
  requires_auth: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input_schema: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output_schema: Record<string, any>;
}

// Deterministic — every Shopify store gets the same capability set
const CAPABILITIES: Capability[] = [
  { id: 'search_products', type: 'search', safety: 'low', requiresAuth: false },
  { id: 'get_product', type: 'read', safety: 'low', requiresAuth: false },
  { id: 'create_cart', type: 'cart', safety: 'medium', requiresAuth: true },
  {
    id: 'initiate_checkout',
    type: 'checkout',
    safety: 'high',
    requiresAuth: true,
    requiresConfirmation: true,
  },
];

export function buildCapabilityMap(
  shop: { shopName: string | null; shopCurrency: string; lastSyncedAt: Date | null },
  productCount: number,
): CapabilityMap {
  return {
    capabilities: CAPABILITIES,
    metadata: {
      shopName: shop.shopName,
      currency: shop.shopCurrency,
      productCount,
      lastSynced: shop.lastSyncedAt,
    },
  };
}

export function deriveToolDefinitions(capMap: CapabilityMap): ToolDefinition[] {
  return capMap.capabilities.map((cap) => TOOL_SCHEMAS[cap.id] ?? {
    name: cap.id,
    type: cap.type,
    safety_level: cap.safety,
    requires_auth: cap.requiresAuth,
    input_schema: { type: 'object', properties: {}, required: [] },
    output_schema: { type: 'object', properties: {} },
  });
}

const TOOL_SCHEMAS: Record<string, ToolDefinition> = {
  search_products: {
    name: 'search_products',
    type: 'search',
    safety_level: 'low',
    requires_auth: false,
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query' },
        filters: {
          type: 'object',
          properties: {
            productType: { type: 'string' },
            vendor: { type: 'string' },
            minPrice: { type: 'number' },
            maxPrice: { type: 'number' },
            size: { type: 'string' },
            color: { type: 'string' },
            inStock: { type: 'boolean' },
          },
        },
        limit: { type: 'integer', default: 20 },
      },
    },
    output_schema: {
      type: 'object',
      properties: {
        results: { type: 'array' },
        totalFound: { type: 'integer' },
      },
    },
  },

  get_product: {
    name: 'get_product',
    type: 'read',
    safety_level: 'low',
    requires_auth: false,
    input_schema: {
      type: 'object',
      required: ['product_id'],
      properties: {
        product_id: { type: 'string', description: 'Shopify product ID' },
      },
    },
    output_schema: {
      type: 'object',
      properties: {
        product: { type: 'object' },
      },
    },
  },

  create_cart: {
    name: 'create_cart',
    type: 'cart',
    safety_level: 'medium',
    requires_auth: true,
    input_schema: {
      type: 'object',
      required: ['lines'],
      properties: {
        lines: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['variant_id', 'quantity'],
            properties: {
              variant_id: { type: 'string' },
              quantity: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
    output_schema: {
      type: 'object',
      properties: {
        cart_id: { type: 'string' },
        lines: { type: 'array' },
        subtotal: { type: 'string' },
        currency: { type: 'string' },
      },
    },
  },

  initiate_checkout: {
    name: 'initiate_checkout',
    type: 'checkout',
    safety_level: 'high',
    requires_auth: true,
    input_schema: {
      type: 'object',
      required: ['cart_id'],
      properties: {
        cart_id: { type: 'string', description: 'Cart ID from create_cart' },
      },
    },
    output_schema: {
      type: 'object',
      properties: {
        checkout_url: { type: 'string', description: 'Shopify native checkout URL' },
        expires_at: { type: 'string' },
      },
    },
  },
};
