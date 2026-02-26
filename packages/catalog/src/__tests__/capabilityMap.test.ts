import { describe, expect, it } from 'vitest';
import { buildCapabilityMap, deriveToolDefinitions } from '../capabilityMap.js';

const MOCK_SHOP = {
  id: 'shop-1',
  shopName: 'Cool Kicks',
  shopCurrency: 'USD',
  shopDomain: 'cool-kicks.myshopify.com',
  lastSyncedAt: new Date('2024-01-15'),
  // minimal shape — only fields used by buildCapabilityMap
} as any;

describe('buildCapabilityMap', () => {
  it('always returns exactly 4 capabilities', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 120);
    expect(map.capabilities).toHaveLength(4);
  });

  it('returns capabilities with correct IDs', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 50);
    const ids = map.capabilities.map((c) => c.id);
    expect(ids).toContain('search_products');
    expect(ids).toContain('get_product');
    expect(ids).toContain('create_cart');
    expect(ids).toContain('initiate_checkout');
  });

  it('read tools have low safety and no auth required', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 50);
    const search = map.capabilities.find((c) => c.id === 'search_products')!;
    const getProduct = map.capabilities.find((c) => c.id === 'get_product')!;
    expect(search.safety).toBe('low');
    expect(search.requiresAuth).toBe(false);
    expect(getProduct.safety).toBe('low');
    expect(getProduct.requiresAuth).toBe(false);
  });

  it('create_cart has medium safety and requires auth', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 50);
    const cart = map.capabilities.find((c) => c.id === 'create_cart')!;
    expect(cart.safety).toBe('medium');
    expect(cart.requiresAuth).toBe(true);
  });

  it('initiate_checkout has high safety, requires auth and confirmation', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 50);
    const checkout = map.capabilities.find((c) => c.id === 'initiate_checkout')!;
    expect(checkout.safety).toBe('high');
    expect(checkout.requiresAuth).toBe(true);
    expect(checkout.requiresConfirmation).toBe(true);
  });

  it('metadata contains shop info and product count', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 77);
    expect(map.metadata.shopName).toBe('Cool Kicks');
    expect(map.metadata.currency).toBe('USD');
    expect(map.metadata.productCount).toBe(77);
    expect(map.metadata.lastSynced).toEqual(new Date('2024-01-15'));
  });

  it('is deterministic — same shop produces identical capability IDs every call', () => {
    const map1 = buildCapabilityMap(MOCK_SHOP, 50);
    const map2 = buildCapabilityMap(MOCK_SHOP, 50);
    expect(map1.capabilities.map((c) => c.id)).toEqual(
      map2.capabilities.map((c) => c.id),
    );
  });
});

describe('deriveToolDefinitions', () => {
  it('returns exactly 4 tool definitions', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 50);
    const tools = deriveToolDefinitions(map);
    expect(tools).toHaveLength(4);
  });

  it('each tool has name, input_schema and output_schema', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 50);
    const tools = deriveToolDefinitions(map);
    for (const tool of tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('input_schema');
      expect(tool).toHaveProperty('output_schema');
    }
  });

  it('search_products input schema requires query string', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 50);
    const tools = deriveToolDefinitions(map);
    const search = tools.find((t) => t.name === 'search_products')!;
    const schema = search.input_schema as any;
    expect(schema.required).toContain('query');
    expect(schema.properties.query.type).toBe('string');
  });

  it('create_cart input schema requires lines array with minimum 1 item', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 50);
    const tools = deriveToolDefinitions(map);
    const cart = tools.find((t) => t.name === 'create_cart')!;
    const schema = cart.input_schema as any;
    expect(schema.required).toContain('lines');
    expect(schema.properties.lines.type).toBe('array');
    expect(schema.properties.lines.minItems).toBe(1);
  });

  it('initiate_checkout input schema requires cart_id', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 50);
    const tools = deriveToolDefinitions(map);
    const checkout = tools.find((t) => t.name === 'initiate_checkout')!;
    const schema = checkout.input_schema as any;
    expect(schema.required).toContain('cart_id');
  });

  it('tool names match capability IDs', () => {
    const map = buildCapabilityMap(MOCK_SHOP, 50);
    const tools = deriveToolDefinitions(map);
    const capIds = map.capabilities.map((c) => c.id).sort();
    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(capIds);
  });
});
