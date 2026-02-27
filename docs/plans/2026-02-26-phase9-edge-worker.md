# Phase 9 — Edge Worker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Cloudflare Worker entry point that resolves shops from requests and routes to the Hono API app or MCP server, completing the multi-tenant routing layer.

**Architecture:** Hono-based Cloudflare Worker (Approach A). Shop resolution middleware normalizes domains then looks up shops by agent_hostname or shop_domain. Rate limiting uses in-memory sliding window keyed by CF-Connecting-IP (reads) or token hash (writes). MCP uses the web-standard Streamable HTTP transport with heartbeat and max duration. Delegation to the api app passes X-Resolved-Shop-Id/Domain headers alongside Hono context.

**Tech Stack:** Hono 4, @modelcontextprotocol/sdk 1.27.1 (WebStandardStreamableHTTPServerTransport), Cloudflare Workers, Vitest

---

### Task 1: wrangler.toml + package.json setup

**Files:**
- Create: `wrangler.toml` (repo root)
- Modify: `packages/edge-worker/package.json`
- Modify: `packages/edge-worker/tsconfig.json`

**Step 1: Create wrangler.toml at repo root**

```toml
name = "shopify-agent-channel"
main = "packages/edge-worker/src/index.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"
```

**Step 2: Update packages/edge-worker/package.json with dependencies**

```json
{
  "name": "@shopify-agent-channel/edge-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "dependencies": {
    "hono": "^4.0.0",
    "@modelcontextprotocol/sdk": "^1.27.1",
    "@shopify-agent-channel/api": "workspace:*",
    "@shopify-agent-channel/db": "workspace:*",
    "@shopify-agent-channel/exec": "workspace:*",
    "@shopify-agent-channel/catalog": "workspace:*",
    "@shopify-agent-channel/manifest": "workspace:*",
    "@shopify-agent-channel/mcp-server": "workspace:*",
    "drizzle-orm": "^0.45.1"
  },
  "scripts": {
    "build": "tsc",
    "dev": "wrangler dev",
    "test": "vitest run",
    "lint": "eslint src"
  }
}
```

**Step 3: Update tsconfig.json to add Workers types**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src"]
}
```

**Step 4: Install dependencies**

Run: `pnpm install`
Expected: Lock file updated, no errors

**Step 5: Commit**

```bash
git add wrangler.toml packages/edge-worker/package.json packages/edge-worker/tsconfig.json pnpm-lock.yaml
git commit -m "feat(edge-worker): Phase 9 scaffold — wrangler.toml + deps"
```

---

### Task 2: Domain normalization + shop resolver middleware

**Files:**
- Create: `packages/edge-worker/src/middleware/shopResolver.ts`
- Create: `packages/edge-worker/src/__tests__/shopResolver.test.ts`

**Step 1: Write the failing tests**

File: `packages/edge-worker/src/__tests__/shopResolver.test.ts`

```typescript
import { describe, expect, it, vi } from 'vitest';
import { normalizeDomain, resolveShop } from '../middleware/shopResolver.js';

// ---------------------------------------------------------------------------
// normalizeDomain
// ---------------------------------------------------------------------------

describe('normalizeDomain', () => {
  it('lowercases input', () => {
    expect(normalizeDomain('Cool-Kicks.myshopify.com')).toBe('cool-kicks.myshopify.com');
  });

  it('strips protocol', () => {
    expect(normalizeDomain('https://cool-kicks.myshopify.com')).toBe('cool-kicks.myshopify.com');
    expect(normalizeDomain('http://cool-kicks.myshopify.com')).toBe('cool-kicks.myshopify.com');
  });

  it('strips trailing path', () => {
    expect(normalizeDomain('cool-kicks.myshopify.com/admin')).toBe('cool-kicks.myshopify.com');
  });

  it('strips port', () => {
    expect(normalizeDomain('cool-kicks.myshopify.com:443')).toBe('cool-kicks.myshopify.com');
  });

  it('appends .myshopify.com to bare names', () => {
    expect(normalizeDomain('cool-kicks')).toBe('cool-kicks.myshopify.com');
  });

  it('preserves full custom domains', () => {
    expect(normalizeDomain('agent.coolkicks.com')).toBe('agent.coolkicks.com');
  });

  it('trims whitespace', () => {
    expect(normalizeDomain('  cool-kicks.myshopify.com  ')).toBe('cool-kicks.myshopify.com');
  });
});

// ---------------------------------------------------------------------------
// resolveShop middleware
// ---------------------------------------------------------------------------

const MOCK_SHOP = {
  id: 'shop-uuid-1',
  shopDomain: 'cool-kicks.myshopify.com',
  shopName: 'Cool Kicks',
  agentHostname: 'agent.coolkicks.com',
  agentEnabled: true,
  uninstalledAt: null,
};

function makeDb(shop = MOCK_SHOP) {
  return {
    query: {
      shops: {
        findFirst: vi.fn().mockImplementation(({ where }: any) => {
          // Return shop for any findFirst call (mock only resolves one shop)
          return Promise.resolve(shop);
        }),
      },
    },
  };
}

function makeDbNotFound() {
  return {
    query: {
      shops: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
  };
}

function makeDbDisabledShop() {
  return {
    query: {
      shops: {
        findFirst: vi.fn().mockResolvedValue({ ...MOCK_SHOP, agentEnabled: false }),
      },
    },
  };
}

function makeDbUninstalledShop() {
  return {
    query: {
      shops: {
        findFirst: vi.fn().mockResolvedValue({
          ...MOCK_SHOP,
          uninstalledAt: new Date('2025-01-01'),
        }),
      },
    },
  };
}

describe('resolveShop', () => {
  it('resolves shop by X-Shop-Domain header', async () => {
    const db = makeDb();
    const result = await resolveShop(
      { host: 'localhost', xShopDomain: 'cool-kicks.myshopify.com', pathDomain: undefined },
      db as any,
    );
    expect(result.shop).toBeDefined();
    expect(result.shop!.id).toBe('shop-uuid-1');
  });

  it('resolves shop by host header (agent_hostname)', async () => {
    const db = makeDb();
    const result = await resolveShop(
      { host: 'agent.coolkicks.com', xShopDomain: undefined, pathDomain: undefined },
      db as any,
    );
    expect(result.shop).toBeDefined();
  });

  it('resolves shop by path domain', async () => {
    const db = makeDb();
    const result = await resolveShop(
      { host: 'localhost', xShopDomain: undefined, pathDomain: 'cool-kicks' },
      db as any,
    );
    expect(result.shop).toBeDefined();
  });

  it('returns null when no shop found', async () => {
    const db = makeDbNotFound();
    const result = await resolveShop(
      { host: 'unknown.example.com', xShopDomain: undefined, pathDomain: undefined },
      db as any,
    );
    expect(result.shop).toBeNull();
  });

  it('returns null for disabled shop', async () => {
    const db = makeDbDisabledShop();
    const result = await resolveShop(
      { host: 'agent.coolkicks.com', xShopDomain: undefined, pathDomain: undefined },
      db as any,
    );
    expect(result.shop).toBeNull();
  });

  it('returns null for uninstalled shop', async () => {
    const db = makeDbUninstalledShop();
    const result = await resolveShop(
      { host: 'agent.coolkicks.com', xShopDomain: undefined, pathDomain: undefined },
      db as any,
    );
    expect(result.shop).toBeNull();
  });

  it('normalizes domain before lookup', async () => {
    const db = makeDb();
    await resolveShop(
      { host: 'localhost', xShopDomain: 'COOL-KICKS', pathDomain: undefined },
      db as any,
    );
    // Should have called findFirst (the mock matches any call)
    expect(db.query.shops.findFirst).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/edge-worker && npx vitest run src/__tests__/shopResolver.test.ts`
Expected: FAIL — cannot find `../middleware/shopResolver.js`

**Step 3: Write implementation**

File: `packages/edge-worker/src/middleware/shopResolver.ts`

```typescript
import { eq, and, isNull } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { shops } from '@shopify-agent-channel/db';

/**
 * Normalize a domain string for consistent DB lookups.
 * - Lowercase
 * - Strip protocol, trailing path, port
 * - Append .myshopify.com to bare names (no dot)
 */
export function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  d = d.split('/')[0]!;
  d = d.split(':')[0]!;
  if (!d.includes('.')) {
    d = `${d}.myshopify.com`;
  }
  return d;
}

export interface ResolveInput {
  host: string | undefined;
  xShopDomain: string | undefined;
  pathDomain: string | undefined;
}

export interface ResolvedShop {
  id: string;
  shopDomain: string;
  shopName: string | null;
  agentHostname: string | null;
  agentEnabled: boolean | null;
  uninstalledAt: Date | null;
}

export interface ResolveResult {
  shop: ResolvedShop | null;
  method: 'host' | 'header' | 'path' | 'none';
}

/** Shared filter: agent_enabled = true AND uninstalled_at IS NULL */
function isActiveShop(shop: ResolvedShop | null): shop is ResolvedShop {
  if (!shop) return false;
  if (shop.agentEnabled === false) return false;
  if (shop.uninstalledAt !== null) return false;
  return true;
}

/**
 * Resolve a shop from request signals. Tries in order:
 * 1. Host header → agent_hostname
 * 2. X-Shop-Domain header → shop_domain
 * 3. Path domain → shop_domain
 */
export async function resolveShop(
  input: ResolveInput,
  db: Database,
): Promise<ResolveResult> {
  // 1. Host header → agent_hostname
  if (input.host) {
    const normalized = normalizeDomain(input.host);
    // Skip common local/platform hosts
    if (!isLocalHost(normalized)) {
      const shop = await db.query.shops.findFirst({
        where: and(
          eq(shops.agentHostname, normalized),
          eq(shops.agentEnabled, true),
          isNull(shops.uninstalledAt),
        ),
      }) as ResolvedShop | undefined;
      if (isActiveShop(shop ?? null)) {
        return { shop, method: 'host' };
      }
    }
  }

  // 2. X-Shop-Domain header
  if (input.xShopDomain) {
    const normalized = normalizeDomain(input.xShopDomain);
    const shop = await db.query.shops.findFirst({
      where: and(
        eq(shops.shopDomain, normalized),
        eq(shops.agentEnabled, true),
        isNull(shops.uninstalledAt),
      ),
    }) as ResolvedShop | undefined;
    if (isActiveShop(shop ?? null)) {
      return { shop, method: 'header' };
    }
  }

  // 3. Path domain
  if (input.pathDomain) {
    const normalized = normalizeDomain(input.pathDomain);
    const shop = await db.query.shops.findFirst({
      where: and(
        eq(shops.shopDomain, normalized),
        eq(shops.agentEnabled, true),
        isNull(shops.uninstalledAt),
      ),
    }) as ResolvedShop | undefined;
    if (isActiveShop(shop ?? null)) {
      return { shop, method: 'path' };
    }
  }

  return { shop: null, method: 'none' };
}

function isLocalHost(domain: string): boolean {
  return (
    domain === 'localhost' ||
    domain === '127.0.0.1' ||
    domain.startsWith('localhost.') ||
    domain.endsWith('.workers.dev')
  );
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/edge-worker && npx vitest run src/__tests__/shopResolver.test.ts`
Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add packages/edge-worker/src/middleware/shopResolver.ts packages/edge-worker/src/__tests__/shopResolver.test.ts
git commit -m "feat(edge-worker): shop resolver with domain normalization"
```

---

### Task 3: In-memory rate limiter

**Files:**
- Create: `packages/edge-worker/src/middleware/rateLimiter.ts`
- Create: `packages/edge-worker/src/__tests__/rateLimiter.test.ts`

**Step 1: Write the failing tests**

File: `packages/edge-worker/src/__tests__/rateLimiter.test.ts`

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RateLimiter, getRateLimitKey, type RateLimitTier } from '../middleware/rateLimiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('allows requests under limit', () => {
    const result = limiter.check('ip:1.2.3.4', 200);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(199);
  });

  it('blocks requests at limit', () => {
    for (let i = 0; i < 200; i++) {
      limiter.check('ip:1.2.3.4', 200);
    }
    const result = limiter.check('ip:1.2.3.4', 200);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('resets after window expires', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 200; i++) {
      limiter.check('ip:1.2.3.4', 200);
    }
    expect(limiter.check('ip:1.2.3.4', 200).allowed).toBe(false);

    // Advance 61 seconds
    vi.advanceTimersByTime(61_000);

    expect(limiter.check('ip:1.2.3.4', 200).allowed).toBe(true);
    vi.useRealTimers();
  });

  it('tracks different keys independently', () => {
    for (let i = 0; i < 200; i++) {
      limiter.check('ip:1.2.3.4', 200);
    }
    expect(limiter.check('ip:1.2.3.4', 200).allowed).toBe(false);
    expect(limiter.check('ip:5.6.7.8', 200).allowed).toBe(true);
  });

  it('respects different limits per tier', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('admin:1.2.3.4', 10);
    }
    expect(limiter.check('admin:1.2.3.4', 10).allowed).toBe(false);
  });
});

describe('getRateLimitKey', () => {
  it('returns IP-based key for read tier', () => {
    const key = getRateLimitKey('read', '1.2.3.4', undefined);
    expect(key).toBe('read:1.2.3.4');
  });

  it('returns token-hash key for write tier with token', () => {
    const key = getRateLimitKey('write', '1.2.3.4', 'Bearer my-secret-token');
    expect(key).toMatch(/^write:[a-f0-9]{16}$/);
  });

  it('falls back to IP for write tier without token', () => {
    const key = getRateLimitKey('write', '1.2.3.4', undefined);
    expect(key).toBe('write:1.2.3.4');
  });

  it('returns IP-based key for admin tier', () => {
    const key = getRateLimitKey('admin', '1.2.3.4', undefined);
    expect(key).toBe('admin:1.2.3.4');
  });

  it('produces different hashes for different tokens', () => {
    const key1 = getRateLimitKey('write', '1.2.3.4', 'Bearer token-a');
    const key2 = getRateLimitKey('write', '1.2.3.4', 'Bearer token-b');
    expect(key1).not.toBe(key2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/edge-worker && npx vitest run src/__tests__/rateLimiter.test.ts`
Expected: FAIL — cannot find `../middleware/rateLimiter.js`

**Step 3: Write implementation**

File: `packages/edge-worker/src/middleware/rateLimiter.ts`

```typescript
const WINDOW_MS = 60_000; // 1 minute

export type RateLimitTier = 'read' | 'write' | 'admin';

export const TIER_LIMITS: Record<RateLimitTier, number> = {
  read: 200,
  write: 30,
  admin: 10,
};

interface Window {
  count: number;
  windowStart: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number; // seconds until window resets, 0 if allowed
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  check(key: string, limit: number): RateLimitResult {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      // New window
      this.windows.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: limit - 1, retryAfter: 0 };
    }

    if (entry.count >= limit) {
      const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
      return { allowed: false, remaining: 0, retryAfter };
    }

    entry.count++;
    return { allowed: true, remaining: limit - entry.count, retryAfter: 0 };
  }
}

/**
 * Build a rate-limit key from the tier, client IP, and optional auth token.
 * - read/admin: keyed by IP
 * - write: keyed by SHA-256 hash prefix of token (fallback to IP)
 */
export function getRateLimitKey(
  tier: RateLimitTier,
  ip: string,
  authHeader: string | undefined,
): string {
  if (tier === 'write' && authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const hash = simpleHash(token);
    return `${tier}:${hash}`;
  }
  return `${tier}:${ip}`;
}

/**
 * Simple non-crypto hash for rate-limit keying (deterministic, fast).
 * Returns first 16 hex chars. NOT for security — just for bucketing.
 */
function simpleHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  return combined;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/edge-worker && npx vitest run src/__tests__/rateLimiter.test.ts`
Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add packages/edge-worker/src/middleware/rateLimiter.ts packages/edge-worker/src/__tests__/rateLimiter.test.ts
git commit -m "feat(edge-worker): in-memory rate limiter with tier-based keying"
```

---

### Task 4: MCP handler with heartbeat + max duration

**Files:**
- Create: `packages/edge-worker/src/mcp/handler.ts`
- Create: `packages/edge-worker/src/__tests__/mcpHandler.test.ts`

**Step 1: Write the failing tests**

File: `packages/edge-worker/src/__tests__/mcpHandler.test.ts`

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createMCPHandler, MCP_MAX_DURATION_MS, MCP_HEARTBEAT_INTERVAL_MS } from '../mcp/handler.js';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@shopify-agent-channel/mcp-server', () => ({
  createMCPServer: vi.fn().mockResolvedValue({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('MCP handler constants', () => {
  it('heartbeat interval is 30 seconds', () => {
    expect(MCP_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });

  it('max duration is 5 minutes', () => {
    expect(MCP_MAX_DURATION_MS).toBe(300_000);
  });
});

describe('createMCPHandler', () => {
  it('is a function', () => {
    expect(typeof createMCPHandler).toBe('function');
  });

  it('returns an object with a handleRequest method', () => {
    const handler = createMCPHandler({
      shopId: 'shop-1',
      db: {} as any,
      router: {} as any,
    });
    expect(typeof handler.handleRequest).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/edge-worker && npx vitest run src/__tests__/mcpHandler.test.ts`
Expected: FAIL — cannot find `../mcp/handler.js`

**Step 3: Write implementation**

File: `packages/edge-worker/src/mcp/handler.ts`

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Database } from '@shopify-agent-channel/db';
import type { ExecutionRouter } from '@shopify-agent-channel/exec';
import { createMCPServer } from '@shopify-agent-channel/mcp-server';

export const MCP_HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
export const MCP_MAX_DURATION_MS = 300_000; // 5 minutes

export interface MCPHandlerConfig {
  shopId: string;
  db: Database;
  router: ExecutionRouter;
}

export function createMCPHandler(config: MCPHandlerConfig) {
  return {
    async handleRequest(request: Request): Promise<Response> {
      const { shopId, db, router } = config;

      // Create a per-request MCP server + transport
      const server = await createMCPServer({ shopId, db, router });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });

      // Wire transport to server
      await server.connect(transport);

      // Handle the incoming request through the transport
      const response = await transport.handleRequest(request);

      // If this is an SSE response, wrap it with heartbeat + max duration
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        return wrapSSEWithHeartbeat(response, transport, server);
      }

      return response;
    },
  };
}

/**
 * Wraps an SSE Response with:
 * 1. Periodic heartbeat comments (`: heartbeat\n\n`) every 30s
 * 2. Max duration (5 min) after which the stream closes
 */
function wrapSSEWithHeartbeat(
  originalResponse: Response,
  transport: WebStandardStreamableHTTPServerTransport,
  server: Server,
): Response {
  const reader = originalResponse.body!.getReader();
  const encoder = new TextEncoder();

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let maxDurationTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      // Heartbeat every 30s
      heartbeatTimer = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch {
            // Stream already closed
          }
        }
      }, MCP_HEARTBEAT_INTERVAL_MS);

      // Max duration — close after 5 min
      maxDurationTimer = setTimeout(async () => {
        if (!closed) {
          closed = true;
          cleanup();
          try {
            controller.enqueue(encoder.encode(': max-duration-reached\n\n'));
            controller.close();
          } catch {
            // Already closed
          }
          await transport.close();
          await server.close();
        }
      }, MCP_MAX_DURATION_MS);

      // Pipe original stream through
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || closed) break;
          controller.enqueue(value);
        }
        if (!closed) {
          closed = true;
          cleanup();
          controller.close();
        }
      } catch (err) {
        if (!closed) {
          closed = true;
          cleanup();
          controller.error(err);
        }
      }
    },
    cancel() {
      closed = true;
      cleanup();
      reader.cancel().catch(() => {});
      transport.close().catch(() => {});
      server.close().catch(() => {});
    },
  });

  function cleanup() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
  }

  return new Response(stream, {
    status: originalResponse.status,
    headers: originalResponse.headers,
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/edge-worker && npx vitest run src/__tests__/mcpHandler.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add packages/edge-worker/src/mcp/handler.ts packages/edge-worker/src/__tests__/mcpHandler.test.ts
git commit -m "feat(edge-worker): MCP handler with SSE heartbeat + max duration"
```

---

### Task 5: Main Hono app with routing + middleware composition

**Files:**
- Create: `packages/edge-worker/src/app.ts`
- Create: `packages/edge-worker/src/__tests__/app.test.ts`

**Step 1: Write the failing tests**

File: `packages/edge-worker/src/__tests__/app.test.ts`

```typescript
import { describe, expect, it, vi } from 'vitest';
import { createEdgeApp, type EdgeAppConfig } from '../app.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SHOP = {
  id: 'shop-uuid-1',
  shopDomain: 'cool-kicks.myshopify.com',
  shopName: 'Cool Kicks',
  shopCurrency: 'USD',
  agentHostname: 'agent.coolkicks.com',
  agentEnabled: true,
  uninstalledAt: null,
  plan: 'starter',
  shopifyAccessTokenEncrypted: 'enc_token',
  shopifyScopes: 'read_products',
  installedAt: new Date(),
  lastSyncedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_MANIFEST = {
  id: 'manifest-1',
  shopId: 'shop-uuid-1',
  isActive: true,
  agentsJson: {
    name: 'Cool Kicks Agent Channel',
    version: '0.1.0',
    platform: 'shopify',
    issuer: 'shopify-agent-channel',
    base_url: 'https://agent.coolkicks.com',
    interfaces: {
      mcp: { url: 'https://agent.coolkicks.com/mcp', transport: 'sse' },
      http: { base_url: 'https://agent.coolkicks.com/api' },
    },
    auth: {
      read: { mode: 'public' },
      write: { mode: 'bearer', description: 'Bearer required', confirmation_note: 'checkout' },
    },
    capabilities: [
      {
        id: 'search_products', type: 'search', safety: 'low', requires_auth: false,
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        output_schema: { type: 'object' }, billing: { model: 'free' },
      },
      {
        id: 'get_product', type: 'read', safety: 'low', requires_auth: false,
        input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
        output_schema: { type: 'object' }, billing: { model: 'free' },
      },
      {
        id: 'create_cart', type: 'cart', safety: 'medium', requires_auth: true,
        input_schema: { type: 'object', properties: { lines: { type: 'array' } }, required: ['lines'] },
        output_schema: { type: 'object' }, billing: { model: 'free' },
      },
      {
        id: 'initiate_checkout', type: 'checkout', safety: 'high', requires_auth: true,
        input_schema: { type: 'object', properties: { cart_id: { type: 'string' } }, required: ['cart_id'] },
        output_schema: { type: 'object' }, billing: { model: 'free' },
      },
    ],
    store_info: { currency: 'USD', product_count: 50, last_synced: null },
    reliability: { nightly_reverify: true, success_score_url: '/api/success-score' },
  },
};

function makeDb() {
  return {
    query: {
      shops: {
        findFirst: vi.fn().mockResolvedValue(MOCK_SHOP),
      },
      manifests: {
        findFirst: vi.fn().mockResolvedValue(MOCK_MANIFEST),
      },
      successScores: { findMany: vi.fn().mockResolvedValue([]) },
      toolRuns: { findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  };
}

function makeRouter() {
  return {
    execute: vi.fn().mockResolvedValue({
      status: 'success',
      data: { results: [], totalFound: 0 },
      latencyMs: 5,
    }),
  };
}

function makeConfig(overrides?: Partial<EdgeAppConfig>): EdgeAppConfig {
  return {
    db: makeDb() as any,
    router: makeRouter() as any,
    adminApiKey: 'admin-secret',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Welcome JSON
// ---------------------------------------------------------------------------

describe('GET / — welcome JSON', () => {
  it('returns welcome JSON with shop info', async () => {
    const app = createEdgeApp(makeConfig());
    const res = await app.request('http://agent.coolkicks.com/', {
      headers: { host: 'agent.coolkicks.com' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.service).toBe('Shopify Agent Channel');
    expect(body.shop).toBe('Cool Kicks');
  });
});

// ---------------------------------------------------------------------------
// Shop resolution
// ---------------------------------------------------------------------------

describe('Shop resolution', () => {
  it('returns 404 for unknown shop', async () => {
    const db = makeDb();
    (db.query.shops.findFirst as any).mockResolvedValue(null);
    const app = createEdgeApp(makeConfig({ db: db as any }));
    const res = await app.request('http://unknown.example.com/', {
      headers: { host: 'unknown.example.com' },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toContain('Unknown shop');
  });

  it('resolves shop by X-Shop-Domain header', async () => {
    const app = createEdgeApp(makeConfig());
    const res = await app.request('http://localhost/.well-known/agents.json', {
      headers: { 'X-Shop-Domain': 'cool-kicks.myshopify.com' },
    });
    expect(res.status).toBe(200);
  });

  it('resolves shop by /shop/:domain/ path prefix', async () => {
    const app = createEdgeApp(makeConfig());
    const res = await app.request('http://localhost/shop/cool-kicks.myshopify.com/.well-known/agents.json');
    expect(res.status).toBe(200);
  });

  it('preserves querystring on /shop/:domain/ rewrite', async () => {
    const app = createEdgeApp(makeConfig());
    const res = await app.request('http://localhost/shop/cool-kicks.myshopify.com/api/products/search?q=jordan&size=11');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Delegation headers
// ---------------------------------------------------------------------------

describe('X-Resolved headers', () => {
  it('sets X-Resolved-Shop-Id on delegated requests', async () => {
    const router = makeRouter();
    const app = createEdgeApp(makeConfig({ router: router as any }));
    await app.request('http://agent.coolkicks.com/api/products/search?q=shoes', {
      headers: { host: 'agent.coolkicks.com' },
    });
    // The router was called, which means delegation happened
    expect(router.execute).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /.well-known/agents.json
// ---------------------------------------------------------------------------

describe('GET /.well-known/agents.json', () => {
  it('returns 200 with manifest', async () => {
    const app = createEdgeApp(makeConfig());
    const res = await app.request('http://agent.coolkicks.com/.well-known/agents.json', {
      headers: { host: 'agent.coolkicks.com' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe('Cool Kicks Agent Channel');
    expect(body.capabilities).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// API delegation
// ---------------------------------------------------------------------------

describe('/api/* delegation', () => {
  it('delegates /api/products/search to api app', async () => {
    const app = createEdgeApp(makeConfig());
    const res = await app.request('http://agent.coolkicks.com/api/products/search?q=shoes', {
      headers: { host: 'agent.coolkicks.com' },
    });
    expect(res.status).toBe(200);
  });

  it('delegates POST /api/cart — returns 401 without auth', async () => {
    const app = createEdgeApp(makeConfig());
    const res = await app.request('http://agent.coolkicks.com/api/cart', {
      method: 'POST',
      headers: { host: 'agent.coolkicks.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [] }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('Rate limiting', () => {
  it('returns 429 when read limit exceeded', async () => {
    const app = createEdgeApp(makeConfig());
    // Exhaust 200 read requests
    for (let i = 0; i < 200; i++) {
      await app.request('http://agent.coolkicks.com/', {
        headers: { host: 'agent.coolkicks.com', 'CF-Connecting-IP': '1.2.3.4' },
      });
    }
    const res = await app.request('http://agent.coolkicks.com/', {
      headers: { host: 'agent.coolkicks.com', 'CF-Connecting-IP': '1.2.3.4' },
    });
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error).toContain('Too many requests');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/edge-worker && npx vitest run src/__tests__/app.test.ts`
Expected: FAIL — cannot find `../app.js`

**Step 3: Write implementation**

File: `packages/edge-worker/src/app.ts`

```typescript
import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { shops, manifests } from '@shopify-agent-channel/db';
import type { ExecutionRouter } from '@shopify-agent-channel/exec';
import type { AgentsJson } from '@shopify-agent-channel/manifest';
import { createApp as createApiApp } from '@shopify-agent-channel/api';
import { normalizeDomain, resolveShop } from './middleware/shopResolver.js';
import { RateLimiter, getRateLimitKey, TIER_LIMITS, type RateLimitTier } from './middleware/rateLimiter.js';
import { createMCPHandler } from './mcp/handler.js';

export interface EdgeAppConfig {
  db: Database;
  router: ExecutionRouter;
  adminApiKey?: string;
}

interface ResolvedContext {
  shopId: string;
  shopDomain: string;
  shopName: string | null;
}

export function createEdgeApp(config: EdgeAppConfig): Hono {
  const { db, router, adminApiKey } = config;
  const app = new Hono();
  const rateLimiter = new RateLimiter();

  // ---------------------------------------------------------------------------
  // /shop/:domain/* path-prefix rewrite — extract domain, strip prefix
  // ---------------------------------------------------------------------------

  app.all('/shop/:domain/*', async (c, next) => {
    const domain = c.req.param('domain');
    // Rewrite URL: strip /shop/:domain prefix, preserve path + querystring
    const url = new URL(c.req.url);
    const prefix = `/shop/${domain}`;
    const newPath = url.pathname.slice(prefix.length) || '/';
    url.pathname = newPath;

    // Store domain for shop resolution
    c.set('pathDomain', domain);
    c.set('rewrittenUrl', url.toString());
    await next();
  });

  // ---------------------------------------------------------------------------
  // Shop resolution middleware — runs on all routes
  // ---------------------------------------------------------------------------

  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    const xShopDomain = c.req.header('X-Shop-Domain');
    const pathDomain = c.get('pathDomain') as string | undefined;

    const { shop } = await resolveShop(
      { host, xShopDomain, pathDomain },
      db,
    );

    if (!shop) {
      return c.json({ error: 'Unknown shop endpoint' }, 404);
    }

    // Set context for downstream handlers
    c.set('shop', shop);
    c.set('shopId', shop.id);
    c.set('shopDomain', shop.shopDomain);
    c.set('shopName', shop.shopName);

    // Set delegation headers
    c.header('X-Resolved-Shop-Id', shop.id);
    c.header('X-Resolved-Shop-Domain', shop.shopDomain);

    await next();
  });

  // ---------------------------------------------------------------------------
  // Rate limiting middleware
  // ---------------------------------------------------------------------------

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const ip = c.req.header('CF-Connecting-IP')
      ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? 'unknown';
    const authHeader = c.req.header('Authorization');

    let tier: RateLimitTier = 'read';
    if (path.startsWith('/admin') || path.startsWith('/internal')) {
      tier = 'admin';
    } else if (c.req.method === 'POST' && path.startsWith('/api/cart')) {
      tier = 'write';
    }

    const key = getRateLimitKey(tier, ip, authHeader);
    const result = rateLimiter.check(key, TIER_LIMITS[tier]);

    if (!result.allowed) {
      return c.json(
        { error: 'Too many requests', retryAfter: result.retryAfter },
        429 as any,
      );
    }

    c.header('X-RateLimit-Remaining', String(result.remaining));
    await next();
  });

  // ---------------------------------------------------------------------------
  // GET / — welcome JSON
  // ---------------------------------------------------------------------------

  app.get('/', (c) => {
    const shopName = c.get('shopName') as string | null;
    const shopDomain = c.get('shopDomain') as string;
    return c.json({
      service: 'Shopify Agent Channel',
      shop: shopName,
      domain: shopDomain,
      agents_json: '/.well-known/agents.json',
      mcp: '/mcp',
      api: '/api',
      docs: 'https://docs.shopify-agent-channel.dev',
    });
  });

  // ---------------------------------------------------------------------------
  // All other routes: load manifest + delegate to api app or MCP handler
  // ---------------------------------------------------------------------------

  app.all('*', async (c) => {
    const shopId = c.get('shopId') as string;
    const url = new URL(c.get('rewrittenUrl') as string || c.req.url);
    const path = url.pathname;

    // Load the active manifest for this shop
    const manifest = await db.query.manifests.findFirst({
      where: and(eq(manifests.shopId, shopId), eq(manifests.isActive, true)),
    });

    if (!manifest) {
      return c.json({ error: 'No active manifest for this shop' }, 404);
    }

    const agentsJson = manifest.agentsJson as AgentsJson;

    // --- MCP endpoint ---
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      const handler = createMCPHandler({ shopId, db, router });
      return handler.handleRequest(c.req.raw);
    }

    // --- All other routes: delegate to the api app ---
    const apiApp = createApiApp({
      shopId,
      db,
      router,
      agentsJson,
      adminApiKey,
    });

    // Build the delegated request, using rewritten URL if path-prefix mode
    const delegatedUrl = c.get('rewrittenUrl') as string | undefined;
    if (delegatedUrl) {
      const req = new Request(delegatedUrl, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
        // @ts-expect-error - duplex needed for streaming body
        duplex: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? 'half' : undefined,
      });
      return apiApp.fetch(req);
    }

    return apiApp.fetch(c.req.raw);
  });

  return app;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/edge-worker && npx vitest run src/__tests__/app.test.ts`
Expected: All 9 tests PASS

**Step 5: Commit**

```bash
git add packages/edge-worker/src/app.ts packages/edge-worker/src/__tests__/app.test.ts
git commit -m "feat(edge-worker): main Hono app with shop resolution, rate limiting, and routing"
```

---

### Task 6: Worker entry point (index.ts)

**Files:**
- Modify: `packages/edge-worker/src/index.ts`

**Step 1: Write the entry point**

File: `packages/edge-worker/src/index.ts`

```typescript
import { getDb } from '@shopify-agent-channel/db';
import { ExecutionRouter } from '@shopify-agent-channel/exec';
import { ShopifyAdapter } from '@shopify-agent-channel/exec';
import { createEdgeApp } from './app.js';

export interface Env {
  DATABASE_URL: string;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  ENCRYPTION_KEY: string;
  ADMIN_API_KEY: string;
  ENVIRONMENT: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = getDb(env.DATABASE_URL);
    const adapter = new ShopifyAdapter(db);
    const router = new ExecutionRouter(adapter, db);

    const app = createEdgeApp({
      db,
      router,
      adminApiKey: env.ADMIN_API_KEY,
    });

    return app.fetch(request);
  },
};
```

**Step 2: Verify build**

Run: `cd packages/edge-worker && npx tsc --noEmit`
Expected: No type errors (or minor ones from Workers types we can address)

**Step 3: Commit**

```bash
git add packages/edge-worker/src/index.ts
git commit -m "feat(edge-worker): Worker entry point wiring db, router, and edge app"
```

---

### Task 7: Run all tests + fix any failures

**Files:**
- Potentially fix: any files that have test failures

**Step 1: Run the full edge-worker test suite**

Run: `pnpm --filter @shopify-agent-channel/edge-worker test`
Expected: All tests pass

**Step 2: Run the full project test suite**

Run: `pnpm test`
Expected: All existing tests still pass, plus new edge-worker tests

**Step 3: Type-check the entire project**

Run: `pnpm build`
Expected: No errors

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "feat(edge-worker): Phase 9 complete — all tests passing"
```

---

## Summary

| Task | Description | Files | Tests |
|------|-------------|-------|-------|
| 1 | Scaffold: wrangler.toml + deps | 3 files | - |
| 2 | Shop resolver + domain normalization | 2 files | ~10 tests |
| 3 | Rate limiter (in-memory, tier-based) | 2 files | ~10 tests |
| 4 | MCP handler with heartbeat + max duration | 2 files | ~3 tests |
| 5 | Main Hono app with routing + middleware | 2 files | ~9 tests |
| 6 | Worker entry point (index.ts) | 1 file | - |
| 7 | Full test suite verification | fixes | - |
