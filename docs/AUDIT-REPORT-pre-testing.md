# Shopify Agent Channel — Pre-Testing Audit Report

**Date:** March 2, 2026  
**Scope:** Validated the Addendum (ADDENDUM-PROD-HARDENING.md) and Build Sheet (AgenticWebbuildsheet.txt) against the actual codebase at `github.com/willynikes2/shopify-agent-channel` (27 commits, main branch).

---

## Addendum Validation: Issue-by-Issue Verdict

### P0.1 — Workers Runtime Compatibility ✅ CONFIRMED — Still Broken

The addendum is **correct**. I found **11 `process.env` references** across production source files:

| File | Lines | What it reads |
|------|-------|---------------|
| `packages/shopify-auth/src/oauth.ts` | 26–27, 47, 69–70 | `SHOPIFY_API_KEY`, `SHOPIFY_APP_URL`, `SHOPIFY_API_SECRET` |
| `packages/api/src/index.ts` | 52, 80, 375, 413 | `ADMIN_API_KEY`, `SHOPIFY_APP_URL`, `ENCRYPTION_KEY`, `SHOPIFY_API_SECRET` |
| `packages/exec/src/adapters/shopify.ts` | 130 | `ENCRYPTION_KEY` |
| `packages/ingest/src/ingestShop.ts` | 25 | `ENCRYPTION_KEY` |

The `wrangler.toml` has `compatibility_date = "2024-01-01"` with **no `nodejs_compat` flag** and **no `compatibility_flags`**. The edge worker entry (`packages/edge-worker/src/index.ts`) does correctly read env from the `fetch(req, env)` parameter and passes `db` and `adminApiKey` into the app, but the downstream packages (`oauth.ts`, `shopify.ts` adapter, `api/index.ts`) still fall back to `process.env` directly, which will crash in Workers.

**Additional finding the addendum missed:** The `api/index.ts` `createApp` function uses `crypto.createHash` and `crypto.timingSafeEqual` from Node's `crypto` module. Without `nodejs_compat`, these will also fail in Workers runtime. The same issue exists in `packages/shopify-auth/src/encryption.ts` (uses `createCipheriv`, `createDecipheriv`, `randomBytes`).

**Recommendation:** Path A (add `nodejs_compat` + `nodejs_compat_v2` flags and `node_compat = true`) is fastest. Path B requires refactoring env through every function signature, which is more work but cleaner. Either way, you also need the compat flags for Node `crypto`.

---

### P0.2 — Schema/Migration Drift ✅ CONFIRMED — Still Drifted

The addendum is **correct**. The `shops` table in the schema has `agentApiKeyHash` (`agent_api_key_hash` column) defined at line 25 of `schema.ts`, but the migration `0000_bizarre_vermin.sql` **does not contain `agent_api_key_hash` anywhere**. Running the migration against a fresh database will create the `shops` table without this column, then any `INSERT` or `SELECT` referencing it will fail.

This is a hard blocker for the OAuth callback flow (which writes `agentApiKeyHash` on install) and all bearer auth checks (which read it).

**Recommendation:** Run `pnpm drizzle-kit generate` to produce a new migration that adds the missing column, or regenerate the baseline.

---

### P0.3 — OAuth HMAC Verification ✅ CONFIRMED — But Partially Fixed

The addendum's concern was that the HMAC only covers hardcoded params. Looking at the actual code in `oauth.ts`:

```typescript
const { hmac, ...rest } = params;
const message = Object.keys(rest)
  .sort()
  .map((k) => `${k}=${rest[k as keyof typeof rest]}`)
  .join('&');
```

This **does** dynamically build the message from all params except `hmac`, sorted alphabetically. So the HMAC logic itself is actually correct in structure.

**However**, the real problem is in `api/index.ts` at the callback handler — it only extracts 4 named params:

```typescript
const params = {
  shop: c.req.query('shop') ?? '',
  code: c.req.query('code') ?? '',
  hmac: c.req.query('hmac') ?? '',
  timestamp: c.req.query('timestamp') ?? '',
};
```

The `state` parameter (which Shopify sends back) is extracted separately and **never passed into `handleOAuthCallback`**. Since `state` is part of the query string that Shopify signs, the HMAC computed from `{code, shop, timestamp}` won't match what Shopify computed from `{code, shop, state, timestamp}`.

**Verdict:** The addendum is correct that HMAC will fail in real installs. The fix is to pass ALL query params (except `hmac`) into the HMAC function, not a hardcoded subset.

---

### P0.4 — Install Flow Blocked by Shop Resolver ⚠️ PARTIALLY FIXED

Looking at the edge worker `app.ts`, I see this logic in the catch-all route handler:

```typescript
const needsManifest = !(
  effectivePath.startsWith('/auth/') ||
  effectivePath.startsWith('/webhooks/')
);
```

This correctly bypasses the **manifest** requirement for auth/webhook routes. **But** the shop resolution middleware (middleware #2) runs **before** the catch-all and returns 404 if no shop is found:

```typescript
if (!result.shop) {
  return c.json({ error: 'Unknown shop endpoint' }, 404);
}
```

For a fresh install, the shop doesn't exist in the DB yet. The request hits shop resolution → 404 → never reaches the auth handler.

**Verdict:** The addendum is **correct**. The auth bypass only exempts manifest loading, not shop resolution. The shop resolver middleware needs to also skip for `/auth/*` and `/webhooks/*` paths.

---

### P0.5 — Storefront Token Handling ✅ CONFIRMED — Still Broken

The addendum is **correct**. In `packages/exec/src/adapters/shopify.ts`, the `createCart` method:

1. Loads the shop from DB
2. Decrypts `shopifyAccessTokenEncrypted` (which is the **Admin API OAuth token**)
3. Passes it to `new StorefrontClient(shop.shopDomain, token)`

Then `StorefrontClient` uses it as `X-Shopify-Storefront-Access-Token`. This is wrong — the Admin OAuth token and the Storefront Access Token are different credentials. The Storefront API will reject or behave unexpectedly with an Admin token.

**Recommendation:** Option B from the addendum — create a Storefront Access Token via the Admin API (`storefrontAccessTokens` mutation) during the install flow, store it in the DB (new column), and use that for cart/checkout operations.

---

### P0.6 — Multi-tenant Auth Confusion ✅ CONFIRMED — Still Present

In `api/index.ts`, the bearer auth middleware looks up the shop by `X-Shop-Domain` header:

```typescript
const shop = await db.query.shops.findFirst({
  where: eq(shops.shopDomain, c.req.header('X-Shop-Domain') ?? ''),
});
```

But the routes execute against the `shopId` that was resolved by the edge worker (which could be from Host header or path prefix). An attacker could send `X-Shop-Domain: their-shop.myshopify.com` (which they have a valid token for) but route to a different shop via the Host/path, causing token validation for shop A but execution on shop B.

**Contrast with MCP server** — the MCP `registerTools.ts` correctly looks up by `shops.id` (the resolved shopId):

```typescript
const shop = await db.query.shops.findFirst({
  where: eq(shops.id, shopId),
});
```

**Verdict:** Addendum is correct. The HTTP API auth is vulnerable; the MCP auth is not.

---

### P1.1 — Rate Limiting (In-Memory) ✅ CONFIRMED

The `RateLimiter` class in `middleware/rateLimiter.ts` uses a simple in-memory `Map`. In Cloudflare Workers, each isolate gets its own memory space, so the rate limit state is per-isolate and resets on every new isolate. An agent could bypass it by distributing requests across enough connections.

**Verdict:** Addendum is correct. This is acceptable for MVP/testing but not production. Durable Objects or Cloudflare's built-in rate limiting would be needed.

---

### P1.2 — HTML Descriptions Unsanitized ✅ CONFIRMED

In `webhooks.ts`, `body_html` from Shopify product webhooks is stored directly into the `description` column without any sanitization. The `ingestShop.ts` flow also stores the raw `description` from the Admin API. If anything downstream renders this HTML, it's an XSS vector.

**Verdict:** Addendum is correct. Store both raw HTML and a stripped text version.

---

### P2.1 — No CI Pipeline ✅ CONFIRMED

No `.github` directory exists. No CI/CD enforcement of any kind.

---

### P2.2 — Test Fixtures Don't Match Validators ⚠️ PARTIALLY TRUE

The test helpers use `adminApiKey: 'admin-secret'` (12 chars), but the real validator in `api/index.ts` enforces `adminApiKey.length < 32` → throws. Tests that mock past this check still pass, but they're not testing real validation. The mock DB shop fixture doesn't have `agentApiKeyHash` set, so bearer auth tests rely on mock behavior, not real crypto validation.

**Verdict:** The addendum is correct that tests are misleadingly green.

---

## My Additional Findings (Not in the Addendum)

### NEW-1: OAuth State Cookie Vulnerable to Timing — Low

The state comparison in `api/index.ts` uses `state !== storedState` (simple string comparison, not timing-safe). For OAuth state this is low risk (it's a CSRF token, not a secret), but since you already use `timingSafeEqual` elsewhere, consistency would be good.

### NEW-2: No Webhook Registration During Install — High

The OAuth callback creates/upserts the shop and returns an `agentApiKey`, but **never registers webhooks** with Shopify. The `products/update` and `app/uninstalled` webhook handlers exist, but Shopify won't send webhooks unless they're registered via the Admin API. Without this, product updates won't sync automatically and uninstall detection won't work.

**Fix:** After successful token exchange, call the Shopify Admin API to register required webhook subscriptions (`app/uninstalled`, `products/update`, `products/create`, `products/delete`).

### NEW-3: No Product Sync Triggered After Install — High

The OAuth callback stores the token but doesn't trigger an initial product ingest. The `ingestShop` function exists but is only called via the admin `/admin/shops/:id/sync` endpoint. A newly installed store will have zero products until someone manually triggers sync.

**Fix:** After the OAuth callback upsert, call `ingestShop(shopId, db)` to populate the catalog.

### NEW-4: Manifest Not Generated After Sync — Medium

The `ingestShop` function syncs products but doesn't generate a manifest. Without a manifest, the edge worker returns 404 for all non-auth routes (`No active manifest for this shop`). The manifest generation (`generateAgentsJson`) needs to be called after product sync.

**Fix:** Chain `generateAgentsJson` → DB insert after `ingestShop` completes.

### NEW-5: `SHOPIFY_APP_URL` Required but Not in Env Type — Medium

The edge worker `Env` interface doesn't include `SHOPIFY_APP_URL`, but the api package requires it for CORS and OAuth redirect URLs. When running in Workers, this value won't be available unless added to `wrangler.toml` vars or the Env interface.

### NEW-6: Cart ID Validation Too Strict — Low

The `SHOPIFY_CART_ID_REGEX` (`/^gid:\/\/shopify\/Cart\/[a-zA-Z0-9_-]+$/`) may not match all valid Shopify cart GIDs. Shopify's cart IDs can include additional characters. Test against real cart GIDs from your dev store to confirm.

### NEW-7: No Error Handling Around DB Insert in ToolRun Recording — Medium

The `ExecutionRouter.recordToolRun` is `await`ed but has no try/catch. If the DB insert fails (connection issue, constraint violation), it will propagate up and crash the entire tool execution, even though the actual Shopify operation may have succeeded. This could cause false failures for users.

**Fix:** Wrap `recordToolRun` in try/catch and log but don't fail the request.

### NEW-8: MCP Server Created Per-Request — Performance Concern

In `mcp/handler.ts`, a new MCP `Server` instance and transport are created for every single request. This includes a DB query to load the manifest each time. For high-traffic shops, this adds unnecessary latency.

**Fix:** For testing this is fine, but for production consider caching the manifest and server instance per shop (e.g., in a Durable Object).

---

## End-to-End Install Flow — Will It Work Today?

Walking through what happens when a merchant clicks "Install":

1. ❌ **GET `/auth/shopify?shop=store.myshopify.com`** — Shop resolver middleware runs first, shop not in DB → **404**. Install never starts.
2. Even if #1 were fixed: ❌ **GET `/auth/shopify/callback?shop=...&code=...&hmac=...&state=...&timestamp=...`** — HMAC verification will fail because `state` is excluded from the signed message.
3. Even if #2 were fixed: ⚠️ Token exchange would succeed, shop upserted, but `agent_api_key_hash` column doesn't exist in DB → **SQL error**.
4. Even if #3 were fixed: ⚠️ No webhooks registered, no product sync triggered, no manifest generated → shop exists but has zero products and no manifest → all API/MCP calls return 404.
5. Even if products were synced manually: ❌ Cart/checkout operations pass the Admin OAuth token to the Storefront API → **authentication failure or undefined behavior**.

**Bottom line:** The install-to-first-query flow has ~5 sequential blockers. None of them are architectural — they're all fixable — but they must be fixed before you can test end-to-end.

---

## Recommended Fix Order for Testing Readiness

This combines the addendum's order with my additional findings:

| Priority | Fix | Estimated Effort |
|----------|-----|-----------------|
| 1 | Add `nodejs_compat` flags to `wrangler.toml` | 5 min |
| 2 | Regenerate DB migration to include `agent_api_key_hash` | 10 min |
| 3 | Bypass shop resolver for `/auth/*` and `/webhooks/*` | 30 min |
| 4 | Fix OAuth HMAC to use ALL query params from the URL | 30 min |
| 5 | Fix Storefront token — create and store a Storefront token during install | 1–2 hrs |
| 6 | Register webhooks after OAuth callback | 1 hr |
| 7 | Trigger product sync + manifest generation after install | 30 min |
| 8 | Fix bearer auth to validate against resolved shopId, not X-Shop-Domain | 30 min |
| 9 | Add `SHOPIFY_APP_URL` to `wrangler.toml` vars and Env interface | 10 min |
| 10 | Wrap `recordToolRun` in try/catch | 10 min |
| 11 | Add CI pipeline | 1 hr |
| 12 | Add Sentry | 1–2 hrs |

After fixes 1–9, you should be able to install on a dev store, sync products, and run queries end-to-end.

---

## Build Sheet Validation (Quick Check)

The build sheet's architecture and module breakdown **accurately describes** what was built. The codebase implements all 8 modules listed. A few notes on alignment:

- Build sheet says "Calendly or Square adapter" — codebase has Shopify adapter (which is the right call for your pivot to Shopify-specific)
- Build sheet says "SSE transport recommended" — codebase uses Streamable HTTP transport, which is the newer MCP standard (good)
- Build sheet's acceptance tests for safety gating and success score are present in the integration tests, though the tests use mocks rather than a real DB
- The repo layout matches the build sheet's recommended structure

The build sheet is solid as a reference doc. No corrections needed there.
