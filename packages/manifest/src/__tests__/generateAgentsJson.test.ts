import { describe, expect, it, vi } from 'vitest';
import { buildCapabilityMap, deriveToolDefinitions } from '@shopify-agent-channel/catalog';
import { generateAgentsJson, saveManifest } from '../generateAgentsJson.js';
import type { Database } from '@shopify-agent-channel/db';

// ---------------------------------------------------------------------------
// Shared fixtures — mock shop with 50 products (per BUILDSHEET spec)
// ---------------------------------------------------------------------------

const MOCK_SHOP = {
  id: 'shop-uuid-1',
  shopName: 'Cool Kicks',
  shopCurrency: 'USD',
  shopDomain: 'cool-kicks.myshopify.com',
  lastSyncedAt: new Date('2024-06-01T00:00:00Z'),
} as any;

const PRODUCT_COUNT = 50;
const BASE_URL = 'https://cool-kicks.agent-channel.dev';

const CAP_MAP = buildCapabilityMap(MOCK_SHOP, PRODUCT_COUNT);
const TOOLS = deriveToolDefinitions(CAP_MAP);

// ---------------------------------------------------------------------------
// generateAgentsJson — structure
// ---------------------------------------------------------------------------

describe('generateAgentsJson — top-level fields', () => {
  it('name is "<shopName> Agent Channel"', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.name).toBe('Cool Kicks Agent Channel');
  });

  it('version is 0.1.0', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.version).toBe('0.1.0');
  });

  it('platform is "shopify"', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.platform).toBe('shopify');
  });

  it('issuer is "shopify-agent-channel"', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.issuer).toBe('shopify-agent-channel');
  });

  it('base_url matches the provided baseUrl', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.base_url).toBe(BASE_URL);
  });

  it('uses fallback name "Shopify Store" when shopName is null', () => {
    const shopNoName = { ...MOCK_SHOP, shopName: null };
    const result = generateAgentsJson({ shop: shopNoName, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.name).toBe('Shopify Store Agent Channel');
  });
});

describe('generateAgentsJson — interfaces', () => {
  it('MCP interface URL is baseUrl + /mcp', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.interfaces.mcp.url).toBe(`${BASE_URL}/mcp`);
  });

  it('MCP transport is "sse"', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.interfaces.mcp.transport).toBe('sse');
  });

  it('HTTP interface base_url is baseUrl + /api', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.interfaces.http.base_url).toBe(`${BASE_URL}/api`);
  });
});

describe('generateAgentsJson — auth config', () => {
  it('read auth mode is "public"', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.auth.read.mode).toBe('public');
  });

  it('write auth mode is "bearer"', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.auth.write.mode).toBe('bearer');
  });

  it('write auth has description and confirmation_note', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.auth.write.description).toBeTruthy();
    expect(result.auth.write.confirmation_note).toContain('checkout_url');
  });
});

describe('generateAgentsJson — capabilities (BUILDSHEET: 4 required)', () => {
  it('has exactly 4 capabilities', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.capabilities).toHaveLength(4);
  });

  it('each capability has id, type, safety, requires_auth, input_schema, output_schema', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    for (const cap of result.capabilities) {
      expect(cap).toHaveProperty('id');
      expect(cap).toHaveProperty('type');
      expect(cap).toHaveProperty('safety');
      expect(cap).toHaveProperty('requires_auth');
      expect(cap).toHaveProperty('input_schema');
      expect(cap).toHaveProperty('output_schema');
    }
  });

  it('each capability has billing.model = "free"', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    for (const cap of result.capabilities) {
      expect((cap as any).billing?.model).toBe('free');
    }
  });

  it('capability IDs are the 4 expected tool names', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    const ids = result.capabilities.map((c) => c.id).sort();
    expect(ids).toEqual(['create_cart', 'get_product', 'initiate_checkout', 'search_products']);
  });
});

describe('generateAgentsJson — store_info', () => {
  it('currency matches shop.shopCurrency', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.store_info.currency).toBe('USD');
  });

  it('product_count matches capabilityMap metadata (50)', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.store_info.product_count).toBe(50);
  });

  it('last_synced matches capabilityMap metadata', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.store_info.last_synced).toEqual(new Date('2024-06-01T00:00:00Z'));
  });
});

describe('generateAgentsJson — reliability', () => {
  it('nightly_reverify is true', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.reliability.nightly_reverify).toBe(true);
  });

  it('success_score_url points to baseUrl/api/success-score', () => {
    const result = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });
    expect(result.reliability.success_score_url).toBe(`${BASE_URL}/api/success-score`);
  });
});

// ---------------------------------------------------------------------------
// saveManifest — DB behaviour
// ---------------------------------------------------------------------------

function makeDb() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const insert = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue(insert);
  return {
    update: vi.fn().mockReturnValue({ set }),
    insert: vi.fn().mockReturnValue({ values }),
    _set: set,
    _where: where,
    _values: values,
    _insert: insert,
  };
}

describe('saveManifest', () => {
  it('deactivates existing manifests before inserting', async () => {
    const db = makeDb();
    const agentsJson = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });

    await saveManifest(db as unknown as Database, 'shop-uuid-1', agentsJson, CAP_MAP, TOOLS);

    expect(db.update).toHaveBeenCalledTimes(1);
    const [setCalls] = [db._set.mock.calls] as any;
    expect(setCalls[0][0]).toMatchObject({ isActive: false });
  });

  it('inserts a new manifest record after deactivating', async () => {
    const db = makeDb();
    const agentsJson = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });

    await saveManifest(db as unknown as Database, 'shop-uuid-1', agentsJson, CAP_MAP, TOOLS);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const insertedValues = db._values.mock.calls[0]![0] as any;
    expect(insertedValues.shopId).toBe('shop-uuid-1');
    expect(insertedValues.isActive).toBe(true);
  });

  it('stores agentsJson, capabilitiesJson, and toolsJson in the record', async () => {
    const db = makeDb();
    const agentsJson = generateAgentsJson({ shop: MOCK_SHOP, capabilityMap: CAP_MAP, tools: TOOLS, baseUrl: BASE_URL });

    await saveManifest(db as unknown as Database, 'shop-uuid-1', agentsJson, CAP_MAP, TOOLS);

    const inserted = db._values.mock.calls[0]![0] as any;
    expect(inserted.agentsJson).toBeDefined();
    expect(inserted.capabilitiesJson).toBeDefined();
    expect(inserted.toolsJson).toBeDefined();
  });
});
