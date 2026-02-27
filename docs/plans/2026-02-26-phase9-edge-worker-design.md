# Phase 9 — Edge Worker (Multi-tenant Router) Design

## Overview

Cloudflare Worker entry point that resolves shops from requests and routes to the Hono API app or MCP server. Built as a Hono app itself (Approach A) for clean middleware composition.

## File Structure

```
packages/edge-worker/
  src/
    index.ts                  # Worker entry: export default app
    app.ts                    # Hono app with middleware + routing
    middleware/
      shopResolver.ts         # Shop resolution + domain normalization
      rateLimiter.ts          # In-memory sliding window rate limiter
    mcp/
      sseHandler.ts           # SSE transport with heartbeat + max duration
    __tests__/
      app.test.ts             # Routing + shop resolution tests
      shopResolver.test.ts    # Domain normalization + resolution tests
      rateLimiter.test.ts     # Rate limiter unit tests
      sseHandler.test.ts      # SSE heartbeat + duration tests
wrangler.toml                 # Repo root — Cloudflare Workers config
```

## Key Design Decisions

### 1. Domain Normalization

All shop domain inputs are normalized before DB lookup:

```typescript
function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  // Strip protocol
  d = d.replace(/^https?:\/\//, '');
  // Strip trailing slash/path
  d = d.split('/')[0];
  // Strip port
  d = d.split(':')[0];
  // Append .myshopify.com if bare name
  if (!d.includes('.')) {
    d = `${d}.myshopify.com`;
  }
  return d;
}
```

Applied to: Host header lookups, X-Shop-Domain header, /shop/:domain path prefix.

The `agent_hostname` column already has a unique constraint in the schema. Domain normalization ensures consistent lookups.

### 2. Shop Resolution (middleware)

Order of precedence:

1. **Host header** → normalize → lookup by `agent_hostname`
2. **X-Shop-Domain header** → normalize → lookup by `shop_domain`
3. **Path prefix** `/shop/:domain/...` → extract domain, normalize, lookup by `shop_domain`, rewrite URL path (preserving querystring)
4. **No match** → 404 `{ error: "Unknown shop endpoint" }`

On successful resolution:
- Set Hono context: `c.set('shop', shop)`
- Set forwarding headers: `X-Resolved-Shop-Id` and `X-Resolved-Shop-Domain` on the request for downstream delegation

Filter: only resolve shops where `agent_enabled = true` AND `uninstalled_at IS NULL`.

### 3. Rate Limiting

In-memory Map-based sliding window per worker instance.

| Route class | Key | Limit |
|---|---|---|
| Read (`/api/products/*`, `/.well-known/*`, `GET /`) | `CF-Connecting-IP` header (fallback `c.req.header('x-forwarded-for')` or `'unknown'`) | 200 req/min |
| Write (`POST /api/cart*`) | SHA-256 hash of Bearer token (fallback to IP) | 30 req/min |
| Admin (`/admin/*`, `/internal/*`) | `CF-Connecting-IP` | 10 req/min |

Implementation: `Map<string, { count: number; windowStart: number }>`. Reset window every 60s. Return `429 Too Many Requests` with `Retry-After` header.

### 4. Routing

Once shop is resolved:

| Path | Handler |
|---|---|
| `GET /` | Welcome JSON with shop info + endpoint URLs |
| `/.well-known/agents.json` | Serve active manifest |
| `/mcp` | MCP SSE handler (per-request server instantiation) |
| `/api/*` | Delegate to `createApp()` from packages/api |
| `/auth/*` | Delegate to `createApp()` (OAuth routes) |
| `/webhooks/*` | Delegate to `createApp()` (webhook handler) |

Delegation to the api app: create a sub-request with `X-Resolved-Shop-Id` and `X-Resolved-Shop-Domain` headers added. The existing api app's `createApp()` receives `shopId` in its config — the edge worker constructs a per-request app config.

### 5. MCP SSE Transport

For `/mcp` endpoint:
- Instantiate `createMCPServer()` per-request with resolved shop
- Use `SSEServerTransport` from `@modelcontextprotocol/sdk/server/sse.js`
- **Heartbeat**: Send SSE comment (`: heartbeat\n\n`) every 30 seconds to keep connection alive
- **Max duration**: 5 minutes (300s). After max duration, send a close event and terminate. Clients should reconnect.
- Clean up transport on disconnect/abort

### 6. Environment Bindings (wrangler.toml)

```toml
name = "shopify-agent-channel"
main = "packages/edge-worker/src/index.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

# Secrets (set via `wrangler secret put`):
# DATABASE_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET,
# ENCRYPTION_KEY, ADMIN_API_KEY
```

### 7. Welcome JSON

```json
{
  "service": "Shopify Agent Channel",
  "shop": "<shop_name>",
  "domain": "<shop_domain>",
  "agents_json": "/.well-known/agents.json",
  "mcp": "/mcp",
  "api": "/api",
  "docs": "https://docs.shopify-agent-channel.dev"
}
```

## Testing Strategy

All tests use Vitest with mock DB (same pattern as packages/api tests).

1. **shopResolver.test.ts**: Domain normalization (protocol stripping, lowercase, .myshopify.com append), resolution from each method (host, header, path), 404 for unknown, skips disabled/uninstalled shops
2. **rateLimiter.test.ts**: Allows under limit, blocks at limit, window reset, correct key selection (IP vs token hash), 429 response format
3. **app.test.ts**: Route delegation (manifest, API, welcome JSON), path rewrite preserves querystring, X-Resolved-Shop-Id/Domain headers set, MCP endpoint responds with SSE content-type
4. **sseHandler.test.ts**: Heartbeat sent at interval, max duration terminates connection

## Dependencies to Add

- `hono` (already in packages/api, add to edge-worker)
- `@modelcontextprotocol/sdk` (already in packages/mcp-server, add to edge-worker)
- Workspace deps: `@shopify-agent-channel/db`, `@shopify-agent-channel/api`, `@shopify-agent-channel/mcp-server`, `@shopify-agent-channel/exec`, `@shopify-agent-channel/catalog`
- Dev: `@cloudflare/workers-types`, `wrangler`

## Implementation Order

1. Create `wrangler.toml` at repo root
2. Update `packages/edge-worker/package.json` with dependencies
3. Implement `middleware/shopResolver.ts` (normalizeDomain + resolution middleware)
4. Implement `middleware/rateLimiter.ts` (sliding window)
5. Implement `mcp/sseHandler.ts` (SSE transport with heartbeat + max duration)
6. Implement `app.ts` (Hono app composing middleware + routes)
7. Implement `index.ts` (Worker entry point)
8. Write all tests
9. Verify with `pnpm --filter @shopify-agent-channel/edge-worker test`
