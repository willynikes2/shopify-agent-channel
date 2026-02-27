import { eq, and, isNull } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { shops } from '@shopify-agent-channel/db';
import type { Database } from '@shopify-agent-channel/db';

type ShopRow = InferSelectModel<typeof shops>;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ResolveInput {
  /** Host header value */
  host: string | undefined;
  /** X-Shop-Domain header value */
  xShopDomain: string | undefined;
  /** Domain extracted from /shop/:domain/ path */
  pathDomain: string | undefined;
}

export interface ResolvedShop {
  id: string;
  shopDomain: string;
  agentHostname: string | null;
  agentEnabled: boolean | null;
  uninstalledAt: Date | null;
  shopName: string | null;
}

export interface ResolveResult {
  shop: ResolvedShop | null;
  method: 'host' | 'header' | 'path' | 'none';
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Hosts that should be skipped for agent_hostname lookup. */
const SKIP_HOSTS = new Set(['localhost', '127.0.0.1']);

function isSkippableHost(host: string): boolean {
  if (SKIP_HOSTS.has(host)) return true;
  if (host.endsWith('.workers.dev')) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/*  normalizeDomain                                                    */
/* ------------------------------------------------------------------ */

/**
 * Normalize a raw domain input:
 * - Trim whitespace
 * - Lowercase
 * - Strip protocol prefix (http:// or https://)
 * - Strip trailing path (everything after first /)
 * - Strip port (everything after first :)
 * - If no dot, append .myshopify.com (bare store name)
 */
export function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();

  // Strip protocol
  if (d.startsWith('https://')) d = d.slice(8);
  else if (d.startsWith('http://')) d = d.slice(7);

  // Strip trailing path
  const slashIdx = d.indexOf('/');
  if (slashIdx !== -1) d = d.slice(0, slashIdx);

  // Strip port
  const colonIdx = d.indexOf(':');
  if (colonIdx !== -1) d = d.slice(0, colonIdx);

  // Bare name → append .myshopify.com
  if (!d.includes('.')) {
    d = `${d}.myshopify.com`;
  }

  return d;
}

/* ------------------------------------------------------------------ */
/*  resolveShop                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve a shop from request signals.
 *
 * Resolution order:
 * 1. Host header → agent_hostname lookup (skip localhost / 127.0.0.1 / *.workers.dev)
 * 2. X-Shop-Domain header → shop_domain lookup
 * 3. Path domain → shop_domain lookup
 * 4. No match → { shop: null, method: 'none' }
 *
 * All lookups require agent_enabled = true AND uninstalled_at IS NULL.
 */
export async function resolveShop(
  input: ResolveInput,
  db: Database,
): Promise<ResolveResult> {
  // 1. Host header → agent_hostname
  if (input.host) {
    const rawHost = input.host.trim().toLowerCase().replace(/:\d+$/, '');
    if (!isSkippableHost(rawHost)) {
      const normalized = normalizeDomain(input.host);
      const shop = await db.query.shops.findFirst({
        where: and(
          eq(shops.agentHostname, normalized),
          eq(shops.agentEnabled, true),
          isNull(shops.uninstalledAt),
        ),
      });
      if (shop) return { shop: toResolvedShop(shop), method: 'host' };
    }
  }

  // 2. X-Shop-Domain header → shop_domain
  if (input.xShopDomain) {
    const normalized = normalizeDomain(input.xShopDomain);
    const shop = await db.query.shops.findFirst({
      where: and(
        eq(shops.shopDomain, normalized),
        eq(shops.agentEnabled, true),
        isNull(shops.uninstalledAt),
      ),
    });
    if (shop) return { shop: toResolvedShop(shop), method: 'header' };
  }

  // 3. Path domain → shop_domain
  if (input.pathDomain) {
    const normalized = normalizeDomain(input.pathDomain);
    const shop = await db.query.shops.findFirst({
      where: and(
        eq(shops.shopDomain, normalized),
        eq(shops.agentEnabled, true),
        isNull(shops.uninstalledAt),
      ),
    });
    if (shop) return { shop: toResolvedShop(shop), method: 'path' };
  }

  // 4. No match
  return { shop: null, method: 'none' };
}

/* ------------------------------------------------------------------ */
/*  Internal mapper                                                    */
/* ------------------------------------------------------------------ */

function toResolvedShop(row: ShopRow): ResolvedShop {
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    agentHostname: row.agentHostname ?? null,
    agentEnabled: row.agentEnabled ?? null,
    uninstalledAt: row.uninstalledAt ?? null,
    shopName: row.shopName ?? null,
  };
}
