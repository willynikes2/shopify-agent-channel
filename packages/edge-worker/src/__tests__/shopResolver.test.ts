import { describe, expect, it, vi } from 'vitest';
import { normalizeDomain, resolveShop, type ResolveInput } from '../middleware/shopResolver.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const MOCK_SHOP = {
  id: '00000000-0000-0000-0000-000000000001',
  shopDomain: 'cool-kicks.myshopify.com',
  agentHostname: 'agent.coolkicks.com',
  agentEnabled: true,
  uninstalledAt: null,
  shopName: 'Cool Kicks',
};

function makeDb(shop: typeof MOCK_SHOP | null = MOCK_SHOP) {
  return {
    query: {
      shops: {
        findFirst: vi.fn().mockResolvedValue(shop),
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  normalizeDomain                                                    */
/* ------------------------------------------------------------------ */

describe('normalizeDomain', () => {
  it('lowercases input', () => {
    expect(normalizeDomain('Cool-Kicks.myshopify.com')).toBe('cool-kicks.myshopify.com');
  });

  it('strips https:// protocol', () => {
    expect(normalizeDomain('https://cool-kicks.myshopify.com')).toBe(
      'cool-kicks.myshopify.com',
    );
  });

  it('strips http:// protocol', () => {
    expect(normalizeDomain('http://cool-kicks.myshopify.com')).toBe(
      'cool-kicks.myshopify.com',
    );
  });

  it('strips trailing path', () => {
    expect(normalizeDomain('cool-kicks.myshopify.com/admin')).toBe(
      'cool-kicks.myshopify.com',
    );
  });

  it('strips port', () => {
    expect(normalizeDomain('cool-kicks.myshopify.com:443')).toBe(
      'cool-kicks.myshopify.com',
    );
  });

  it('appends .myshopify.com to bare names', () => {
    expect(normalizeDomain('cool-kicks')).toBe('cool-kicks.myshopify.com');
  });

  it('preserves full custom domains', () => {
    expect(normalizeDomain('agent.coolkicks.com')).toBe('agent.coolkicks.com');
  });

  it('trims whitespace', () => {
    expect(normalizeDomain('  cool-kicks.myshopify.com  ')).toBe(
      'cool-kicks.myshopify.com',
    );
  });
});

/* ------------------------------------------------------------------ */
/*  resolveShop                                                        */
/* ------------------------------------------------------------------ */

describe('resolveShop', () => {
  it('resolves by X-Shop-Domain header', async () => {
    const db = makeDb();
    const input: ResolveInput = {
      host: undefined,
      xShopDomain: 'cool-kicks.myshopify.com',
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    expect(result.method).toBe('header');
    expect(result.shop).not.toBeNull();
    expect(result.shop!.shopDomain).toBe('cool-kicks.myshopify.com');
  });

  it('resolves by host header (agent_hostname)', async () => {
    const db = makeDb();
    const input: ResolveInput = {
      host: 'agent.coolkicks.com',
      xShopDomain: undefined,
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    expect(result.method).toBe('host');
    expect(result.shop).not.toBeNull();
    expect(result.shop!.agentHostname).toBe('agent.coolkicks.com');
  });

  it('resolves by path domain', async () => {
    const db = makeDb();
    const input: ResolveInput = {
      host: undefined,
      xShopDomain: undefined,
      pathDomain: 'cool-kicks.myshopify.com',
    };

    const result = await resolveShop(input, db as any);

    expect(result.method).toBe('path');
    expect(result.shop).not.toBeNull();
  });

  it('returns null for unknown shop', async () => {
    const db = makeDb(null);
    const input: ResolveInput = {
      host: undefined,
      xShopDomain: 'unknown-shop.myshopify.com',
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    expect(result.shop).toBeNull();
    expect(result.method).toBe('none');
  });

  it('returns null for disabled shop', async () => {
    const disabledShop = { ...MOCK_SHOP, agentEnabled: false };
    const db = makeDb(disabledShop);
    // findFirst returns the shop but agentEnabled = false → the WHERE clause
    // should filter it out. Since our mock returns the shop regardless,
    // we simulate the DB returning null (as it would with WHERE agent_enabled = true).
    db.query.shops.findFirst.mockResolvedValue(null);

    const input: ResolveInput = {
      host: undefined,
      xShopDomain: 'cool-kicks.myshopify.com',
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    expect(result.shop).toBeNull();
    expect(result.method).toBe('none');
  });

  it('returns null for uninstalled shop', async () => {
    const uninstalledShop = {
      ...MOCK_SHOP,
      uninstalledAt: new Date('2024-01-01'),
    };
    const db = makeDb(uninstalledShop);
    // DB WHERE clause filters out uninstalled shops
    db.query.shops.findFirst.mockResolvedValue(null);

    const input: ResolveInput = {
      host: undefined,
      xShopDomain: 'cool-kicks.myshopify.com',
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    expect(result.shop).toBeNull();
    expect(result.method).toBe('none');
  });

  it('normalizes domain before lookup', async () => {
    const db = makeDb();
    const input: ResolveInput = {
      host: undefined,
      xShopDomain: 'https://Cool-Kicks.myshopify.com/admin',
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    expect(result.method).toBe('header');
    expect(result.shop).not.toBeNull();
    // Verify the findFirst was called (domain was normalized before query)
    expect(db.query.shops.findFirst).toHaveBeenCalled();
  });

  it('skips host header for localhost', async () => {
    const db = makeDb();
    const input: ResolveInput = {
      host: 'localhost',
      xShopDomain: 'cool-kicks.myshopify.com',
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    // Should skip localhost host and fall through to header
    expect(result.method).toBe('header');
  });

  it('skips host header for 127.0.0.1', async () => {
    const db = makeDb();
    const input: ResolveInput = {
      host: '127.0.0.1',
      xShopDomain: 'cool-kicks.myshopify.com',
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    expect(result.method).toBe('header');
  });

  it('skips host header for *.workers.dev', async () => {
    const db = makeDb();
    const input: ResolveInput = {
      host: 'shopify-agent-channel.my-account.workers.dev',
      xShopDomain: 'cool-kicks.myshopify.com',
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    expect(result.method).toBe('header');
  });

  it('prefers host over header when both are present', async () => {
    const db = makeDb();
    const input: ResolveInput = {
      host: 'agent.coolkicks.com',
      xShopDomain: 'cool-kicks.myshopify.com',
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    expect(result.method).toBe('host');
  });

  it('returns none when all signals are undefined', async () => {
    const db = makeDb();
    const input: ResolveInput = {
      host: undefined,
      xShopDomain: undefined,
      pathDomain: undefined,
    };

    const result = await resolveShop(input, db as any);

    expect(result.shop).toBeNull();
    expect(result.method).toBe('none');
  });
});
