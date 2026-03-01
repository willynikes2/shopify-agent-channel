# Security Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 14 security vulnerabilities (2 critical, 4 high, 5 medium, 3 low) identified by audit.

**Architecture:** Surgical fixes to existing files — no new packages, no restructuring. Fixes are scoped to `packages/api`, `packages/shopify-auth`, `packages/mcp-server`, `packages/edge-worker`, `packages/exec`.

**Tech Stack:** TypeScript, Hono, Zod, Node crypto, Drizzle ORM

**Note:** Some changes build on uncommitted work already in the working tree. The plan assumes that diff is the starting state.

---

## Task 1: CRITICAL — Wire OAuth state (CSRF protection)

**Files:**
- Modify: `packages/api/src/index.ts:286-325` (install + callback routes)
- Modify: `packages/shopify-auth/src/oauth.ts:39-81` (add state param to callback)

**Step 1: Fix `/auth/shopify` to generate + pass state**

In `packages/api/src/index.ts`, replace the install route (lines 286-291):

```typescript
app.get('/auth/shopify', async (c) => {
  const shopDomain = c.req.query('shop');
  if (!shopDomain) return c.json({ error: 'Missing shop parameter' }, 400);
  const state = generateOAuthState();
  // Store state in a short-lived cookie (HttpOnly, SameSite=Lax, 5 min expiry)
  c.header('Set-Cookie', `oauth_state=${state}; HttpOnly; SameSite=Lax; Max-Age=300; Path=/auth/shopify/callback; Secure`);
  const url = await generateInstallUrl(shopDomain, state);
  return c.redirect(url);
});
```

Add `generateOAuthState` and `validateOAuthState` to the imports from `@shopify-agent-channel/shopify-auth` (already exported, just need to import).

**Step 2: Fix `/auth/shopify/callback` to validate state**

In `packages/api/src/index.ts`, replace the callback route (lines 293-326):

```typescript
app.get('/auth/shopify/callback', async (c) => {
  const state = c.req.query('state') ?? '';
  // Retrieve stored state from cookie
  const cookieHeader = c.req.header('Cookie') ?? '';
  const storedState = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('oauth_state='))?.split('=')[1] ?? '';
  // Clear the cookie
  c.header('Set-Cookie', 'oauth_state=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/auth/shopify/callback; Secure');
  // Validate state
  try {
    validateOAuthState(state);
  } catch {
    return c.json({ error: 'Invalid or missing OAuth state' }, 400);
  }
  if (state !== storedState) {
    return c.json({ error: 'OAuth state mismatch — possible CSRF' }, 400);
  }
  const params = {
    shop: c.req.query('shop') ?? '',
    code: c.req.query('code') ?? '',
    hmac: c.req.query('hmac') ?? '',
    timestamp: c.req.query('timestamp') ?? '',
  };
  try {
    const { accessToken, scopes } = await handleOAuthCallback(params);
    const encKey = process.env['ENCRYPTION_KEY'] ?? '';
    validateEncryptionKey(encKey);
    const encrypted = encryptToken(accessToken, encKey);
    const agentApiKey = randomBytes(32).toString('hex');
    const agentApiKeyHash = createHash('sha256').update(agentApiKey).digest('hex');
    await db.insert(shops).values({
      shopDomain: params.shop,
      shopifyAccessTokenEncrypted: encrypted,
      shopifyScopes: scopes,
      agentApiKeyHash,
    }).onConflictDoUpdate({
      target: shops.shopDomain,
      set: { shopifyAccessTokenEncrypted: encrypted, shopifyScopes: scopes, agentApiKeyHash, updatedAt: new Date() },
    });
    return c.json({ success: true, shopDomain: params.shop, agentApiKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'OAuth error';
    return c.json({ error: msg }, 400);
  }
});
```

Add to imports at top of file:

```typescript
import {
  generateInstallUrl,
  handleOAuthCallback,
  verifyShopifyWebhook,
  handleAppUninstalled,
  handleProductsUpdate,
  validateEncryptionKey,
  encryptToken,
  generateOAuthState,
  validateOAuthState,
} from '@shopify-agent-channel/shopify-auth';
```

**Step 3: Run tests**

```bash
cd packages/api && pnpm test
```

**Step 4: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "fix(security): wire OAuth state CSRF protection with cookie-based nonce"
```

---

## Task 2: CRITICAL — Verify MCP auth token against DB

**Files:**
- Modify: `packages/mcp-server/src/registerTools.ts:49-70`
- Modify: `packages/mcp-server/src/index.ts` (pass db to registerTools)

**Step 1: Update registerTools to accept db and verify token**

In `packages/mcp-server/src/registerTools.ts`, add imports and update the function:

```typescript
import { createHash, timingSafeEqual } from 'crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { shops } from '@shopify-agent-channel/db';
```

Update function signature:

```typescript
export function registerTools(
  server: Server,
  agentsJson: AgentsJson,
  shopId: string,
  router: ExecutionRouter,
  db: Database,
): void {
```

Replace the auth logic inside `CallToolRequestSchema` handler (lines 64-65):

```typescript
// Verify auth token against stored hash (same logic as HTTP bearerAuth)
let isAuthenticated = !toolDef.requires_auth; // public tools always pass
if (toolDef.requires_auth) {
  if (!authToken) {
    return {
      content: [{ type: 'text' as const, text: 'Authentication required. Provide a valid API token in _meta.authToken.' }],
      isError: true,
    };
  }
  const tokenHash = createHash('sha256').update(authToken).digest('hex');
  const shop = await db.query.shops.findFirst({
    where: eq(shops.id, shopId),
  });
  if (!shop?.agentApiKeyHash) {
    return {
      content: [{ type: 'text' as const, text: 'No API key configured for this shop.' }],
      isError: true,
    };
  }
  const expected = Buffer.from(shop.agentApiKeyHash, 'hex');
  const actual = Buffer.from(tokenHash, 'hex');
  isAuthenticated = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!isAuthenticated) {
    return {
      content: [{ type: 'text' as const, text: 'Invalid API token.' }],
      isError: true,
    };
  }
}
```

Remove `token: authToken` from the `authContext` passed to `router.execute`:

```typescript
const result = await router.execute(
  { shopId, toolName, inputs, authContext: { isAuthenticated } },
  toolDef,
);
```

**Step 2: Update createMCPServer to pass db**

In `packages/mcp-server/src/index.ts`, pass `db` to `registerTools`:

```typescript
registerTools(server, agentsJson, config.shopId, config.router, config.db);
```

**Step 3: Run tests**

```bash
cd packages/mcp-server && pnpm test
```

**Step 4: Commit**

```bash
git add packages/mcp-server/src/registerTools.ts packages/mcp-server/src/index.ts
git commit -m "fix(security): verify MCP auth tokens against stored hash"
```

---

## Task 3: HIGH — Startup assertions for required secrets

**Files:**
- Modify: `packages/api/src/index.ts:41-43`

**Step 1: Add assertions at top of createApp**

After the `adminApiKey` assignment (line 43), add:

```typescript
if (!adminApiKey || adminApiKey.length < 32) {
  throw new Error('ADMIN_API_KEY must be set and at least 32 characters');
}
```

**Step 2: Run tests (update tests that don't set adminApiKey)**

```bash
cd packages/api && pnpm test
```

Tests that create apps without adminApiKey will need to pass a dummy key of 32+ chars.

**Step 3: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "fix(security): assert ADMIN_API_KEY is set and has minimum entropy"
```

---

## Task 4: HIGH — Remove CORS localhost fallback

**Files:**
- Modify: `packages/api/src/index.ts:68-72`

**Step 1: Replace CORS config**

```typescript
const corsOrigin = process.env['SHOPIFY_APP_URL'];
if (!corsOrigin) {
  throw new Error('SHOPIFY_APP_URL must be set');
}

app.use('*', cors({
  origin: corsOrigin,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'X-Shop-Domain', 'X-Admin-Key'],
}));
```

**NOTE:** This will break tests. For tests, pass `SHOPIFY_APP_URL=http://localhost:3000` in the test env setup.

**Step 2: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "fix(security): fail closed when SHOPIFY_APP_URL is unset"
```

---

## Task 5: HIGH — Guard webhook JSON.parse + topic allowlist

**Files:**
- Modify: `packages/api/src/index.ts:328-346`

**Step 1: Replace webhook handler**

```typescript
app.post('/webhooks/shopify', async (c) => {
  const body = await c.req.text();
  const hmac = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
  const topic = c.req.header('X-Shopify-Topic') ?? '';
  const shopDomain = c.req.header('X-Shopify-Shop-Domain') ?? '';
  const secret = process.env['SHOPIFY_API_SECRET'] ?? '';

  if (!verifyShopifyWebhook(body, hmac, secret)) {
    return c.json({ error: 'Invalid webhook signature' }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid webhook body' }, 400);
  }

  const KNOWN_TOPICS = ['app/uninstalled', 'products/update'] as const;
  if (topic === 'app/uninstalled') {
    await handleAppUninstalled(shopDomain, db);
  } else if (topic === 'products/update') {
    await handleProductsUpdate(shopDomain, payload, db);
  } else {
    // Acknowledge but log unknown topics
    console.warn(`[webhook] unhandled topic: ${topic} from ${shopDomain}`);
  }
  return c.json({ ok: true });
});
```

**Step 2: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "fix(security): guard webhook JSON.parse + log unknown topics"
```

---

## Task 6: HIGH — Remove ENCRYPTION_KEY `!` assertion in adapter

**Files:**
- Modify: `packages/exec/src/adapters/shopify.ts:81-84,115-118`

**Step 1: Replace `!` with validated access**

```typescript
private getEncryptionKey(): string {
  const key = process.env['ENCRYPTION_KEY'] ?? '';
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return key;
}
```

Replace both `process.env['ENCRYPTION_KEY']!` calls with `this.getEncryptionKey()`.

**Step 2: Commit**

```bash
git add packages/exec/src/adapters/shopify.ts
git commit -m "fix(security): validate ENCRYPTION_KEY instead of non-null assertion"
```

---

## Task 7: MEDIUM — Add security response headers

**Files:**
- Modify: `packages/api/src/index.ts` (add middleware after CORS)
- Modify: `packages/edge-worker/src/app.ts` (add middleware at top)

**Step 1: Add security headers middleware to API**

After the CORS middleware in `packages/api/src/index.ts`:

```typescript
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-XSS-Protection', '0');
});
```

**Step 2: Add same middleware to edge-worker**

In `packages/edge-worker/src/app.ts`, add as first middleware (before shop resolution):

```typescript
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-XSS-Protection', '0');
});
```

**Step 3: Remove internal shop UUID from response headers**

In `packages/edge-worker/src/app.ts` (lines 89-90), remove:

```typescript
// DELETE these lines:
c.header('X-Resolved-Shop-Id', shop.id);
c.header('X-Resolved-Shop-Domain', shop.shopDomain);
```

**Step 4: Commit**

```bash
git add packages/api/src/index.ts packages/edge-worker/src/app.ts
git commit -m "fix(security): add security response headers, remove internal shop UUID exposure"
```

---

## Task 8: MEDIUM — Validate product_id and cart_id format

**Files:**
- Modify: `packages/api/src/index.ts:165-182,220-233`

**Step 1: Add ID validation regex near Zod schemas**

```typescript
const SHOPIFY_ID_REGEX = /^(gid:\/\/shopify\/\w+\/\d+|\d+)$/;
const SHOPIFY_CART_ID_REGEX = /^gid:\/\/shopify\/Cart\/[a-zA-Z0-9_-]+$/;
```

**Step 2: Add validation in product_id route**

```typescript
app.get('/api/products/:product_id', async (c) => {
  const productId = c.req.param('product_id');
  if (!SHOPIFY_ID_REGEX.test(productId)) {
    return c.json({ error: 'Invalid product_id format' }, 400);
  }
  // ... rest unchanged
});
```

**Step 3: Add validation in cart checkout route**

```typescript
app.post('/api/cart/:cart_id/checkout', bearerAuth, async (c) => {
  const cartId = c.req.param('cart_id');
  if (!SHOPIFY_CART_ID_REGEX.test(cartId)) {
    return c.json({ error: 'Invalid cart_id format' }, 400);
  }
  // ... rest unchanged
});
```

**Step 4: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "fix(security): validate product_id and cart_id format before DB/API calls"
```

---

## Task 9: MEDIUM — Add Zod schema for webhook product payload

**Files:**
- Modify: `packages/shopify-auth/src/webhooks.ts`

**Step 1: Add Zod schema and validate before DB write**

```typescript
import { z } from 'zod';

const WebhookProductSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().optional().default(''),
  body_html: z.string().nullable().optional(),
  product_type: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  tags: z.string().optional().default(''),
  status: z.string().optional().default('active'),
  variants: z.array(z.record(z.unknown())).optional().default([]),
  images: z.array(z.record(z.unknown())).optional().default([]),
  updated_at: z.string().nullable().optional(),
}).passthrough();
```

Update `handleProductsUpdate`:

```typescript
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
  // ... rest of function uses product.id, product.title, etc.
```

**Step 2: Commit**

```bash
git add packages/shopify-auth/src/webhooks.ts
git commit -m "fix(security): validate webhook product payload with Zod before DB write"
```

---

## Task 10: MEDIUM — Document rate limiter limitations

**Files:**
- Modify: `packages/edge-worker/src/middleware/rateLimiter.ts` (add comment + prefer CF-Connecting-IP)

**Step 1: Add documentation comment and tighten IP trust**

At top of file, add:

```typescript
/**
 * In-process rate limiter. LIMITATIONS:
 * - State is per-isolate — does NOT persist across Cloudflare Worker instances.
 * - For production, replace with Durable Objects or KV-backed limiter.
 * - X-Forwarded-For is only used as fallback; CF-Connecting-IP is preferred.
 */
```

In `packages/edge-worker/src/app.ts` rate limit middleware, change IP extraction:

```typescript
const cfIp = c.req.header('CF-Connecting-IP');
const ip = cfIp ?? 'unknown';
// NOTE: X-Forwarded-For intentionally not trusted — attacker-controlled
```

**Step 2: Commit**

```bash
git add packages/edge-worker/src/middleware/rateLimiter.ts packages/edge-worker/src/app.ts
git commit -m "fix(security): document rate limiter limitations, stop trusting X-Forwarded-For"
```

---

## Task 11: LOW — Log null agentApiKeyHash condition

**Files:**
- Modify: `packages/api/src/index.ts:89-91`

**Step 1: Add log warning**

```typescript
if (!shop?.agentApiKeyHash) {
  console.warn(`[auth] shop ${c.req.header('X-Shop-Domain')} has no agentApiKeyHash — broken install state`);
  return c.json({ error: 'No API key configured for this shop' }, 401);
}
```

**Step 2: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "fix(security): warn on null agentApiKeyHash indicating broken install"
```

---

## Task 12: Run all tests + final verification

**Step 1: Run full test suite**

```bash
pnpm -r test
```

**Step 2: Verify all changes compile**

```bash
pnpm -r build
```

**Step 3: Final commit if any test fixes needed**

---

## Summary

| Task | Severity | Fix |
|------|----------|-----|
| 1 | CRITICAL | OAuth state CSRF via cookie nonce |
| 2 | CRITICAL | MCP auth token verified against DB hash |
| 3 | HIGH | ADMIN_API_KEY startup assertion |
| 4 | HIGH | CORS fails closed without SHOPIFY_APP_URL |
| 5 | HIGH | Webhook JSON.parse guarded + topic allowlist |
| 6 | HIGH | ENCRYPTION_KEY validated, not `!` asserted |
| 7 | MEDIUM | Security response headers + remove shop UUID exposure |
| 8 | MEDIUM | product_id / cart_id format validation |
| 9 | MEDIUM | Zod schema for webhook product payload |
| 10 | MEDIUM | Rate limiter docs + stop trusting X-Forwarded-For |
| 11 | LOW | Log null agentApiKeyHash |
| 12 | — | Full test suite verification |
