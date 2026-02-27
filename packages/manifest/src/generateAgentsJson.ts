import { eq } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { manifests } from '@shopify-agent-channel/db';
import type { CapabilityMap, ToolDefinition } from '@shopify-agent-channel/catalog';

export interface AgentsJsonCapability {
  id: string;
  type: string;
  safety: string;
  requires_auth: boolean;
  input_schema: unknown;
  output_schema: unknown;
  billing: { model: string };
}

export interface AgentsJson {
  name: string;
  version: string;
  platform: string;
  issuer: string;
  base_url: string;
  interfaces: {
    mcp: { url: string; transport: string };
    http: { base_url: string };
  };
  auth: {
    read: { mode: string };
    write: { mode: string; description: string; confirmation_note: string };
  };
  capabilities: AgentsJsonCapability[];
  store_info: {
    currency: string;
    product_count: number;
    last_synced: Date | null;
  };
  reliability: {
    nightly_reverify: boolean;
    success_score_url: string;
  };
}

export function generateAgentsJson(config: {
  shop: { shopName: string | null; shopCurrency: string | null };
  capabilityMap: CapabilityMap;
  tools: ToolDefinition[];
  baseUrl: string;
}): AgentsJson {
  const { shop, capabilityMap, tools, baseUrl } = config;
  return {
    name: `${shop.shopName ?? 'Shopify Store'} Agent Channel`,
    version: '0.1.0',
    platform: 'shopify',
    issuer: 'shopify-agent-channel',
    base_url: baseUrl,
    interfaces: {
      mcp: { url: `${baseUrl}/mcp`, transport: 'sse' },
      http: { base_url: `${baseUrl}/api` },
    },
    auth: {
      read: { mode: 'public' },
      write: {
        mode: 'bearer',
        description: 'Cart and checkout tools require a valid API key or agent token.',
        confirmation_note:
          'initiate_checkout returns a checkout_url. The user completes payment via Shopify checkout (Shop Pay / Apple Pay). We never handle payment directly.',
      },
    },
    capabilities: tools.map((tool) => ({
      id: tool.name,
      type: tool.type,
      safety: tool.safety_level,
      requires_auth: tool.requires_auth,
      input_schema: tool.input_schema,
      output_schema: tool.output_schema,
      billing: { model: 'free' },
    })),
    store_info: {
      currency: shop.shopCurrency ?? 'USD',
      product_count: capabilityMap.metadata.productCount,
      last_synced: capabilityMap.metadata.lastSynced,
    },
    reliability: {
      nightly_reverify: true,
      success_score_url: `${baseUrl}/api/success-score`,
    },
  };
}

export async function saveManifest(
  db: Database,
  shopId: string,
  agentsJson: AgentsJson,
  capMap: CapabilityMap,
  tools: ToolDefinition[],
): Promise<void> {
  // Deactivate all previous manifests for this shop
  await db.update(manifests).set({ isActive: false }).where(eq(manifests.shopId, shopId));

  // Insert the new active manifest
  await db.insert(manifests).values({
    shopId,
    capabilitiesJson: capMap.capabilities,
    toolsJson: tools,
    agentsJson,
    isActive: true,
  });
}
