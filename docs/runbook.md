# Runbook

Development setup, operations, and troubleshooting for the Shopify Agent Channel.

---

## Prerequisites

- **Node.js** 20+
- **pnpm** 9+
- **PostgreSQL** 15+ (or a Neon serverless database)
- **Shopify Partner account** with a development store

---

## Environment Variables

Create a `.env` file in the project root (never commit this):

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/shopify_agent_channel
ENCRYPTION_KEY=<32-byte-hex-string>
SHOPIFY_API_KEY=<from-shopify-partner-dashboard>
SHOPIFY_API_SECRET=<from-shopify-partner-dashboard>
ADMIN_API_KEY=<random-secret-for-admin-endpoints>
```

| Variable            | Purpose                                       |
|---------------------|-----------------------------------------------|
| `DATABASE_URL`      | PostgreSQL connection string                  |
| `ENCRYPTION_KEY`    | Encrypts stored Shopify access tokens (32 bytes hex) |
| `SHOPIFY_API_KEY`   | Shopify app API key                           |
| `SHOPIFY_API_SECRET`| Shopify app secret (webhooks + OAuth)         |
| `ADMIN_API_KEY`     | Authenticates admin/internal API routes       |

---

## Shopify Partner Setup

1. Create a Shopify Partner account at https://partners.shopify.com
2. Create a new app in the Partner Dashboard
3. Set the App URL to your dev URL (e.g., `https://localhost:3000`)
4. Set the Allowed redirection URL to `https://localhost:3000/auth/shopify/callback`
5. Copy the API key and secret into your `.env`
6. Create a development store for testing

---

## Local Development

```bash
# Install dependencies
pnpm install

# Run database migrations
pnpm db:migrate

# Build all packages
pnpm build

# Run unit tests (all packages)
pnpm test

# Run integration tests
pnpm test:integration

# Start development servers
pnpm dev
```

---

## Common Operations

### Register and sync a shop

```bash
# Register shop (after OAuth install)
curl -X POST http://localhost:3000/admin/shops \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"shop_domain": "my-store.myshopify.com"}'

# Trigger product catalog sync
curl -X POST http://localhost:3000/admin/shops/shop_abc/sync \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

### Check shop manifest

```bash
curl http://localhost:3000/admin/shops/shop_abc/manifest \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

### Run reverification

```bash
curl -X POST http://localhost:3000/internal/reverify \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

### Check success scores

```bash
curl http://localhost:3000/api/success-score
```

### View recent tool runs

```bash
curl "http://localhost:3000/admin/shops/shop_abc/runs?limit=10" \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

---

## Adding a New Tool

1. **Define the capability** in `packages/catalog/src/capabilityMap.ts`:
   - Add to the `CAPABILITIES` array with id, type, safety level, auth requirements
   - Add the input/output schema in `TOOL_SCHEMAS`

2. **Implement the adapter** in `packages/exec/src/adapters/`:
   - Create a handler function that calls the appropriate Shopify API
   - Register it in the execution router

3. **Register in MCP** in `packages/mcp-server/src/registerTools.ts`:
   - Add a description in `TOOL_DESCRIPTIONS`

4. **Add HTTP route** in `packages/api/src/index.ts` (if the tool should be accessible via REST)

5. **Write tests**:
   - Unit tests in the package's `__tests__/` directory
   - Integration test in `tests/integration/`

6. **Rebuild and test**:
   ```bash
   pnpm build && pnpm test && pnpm test:integration
   ```

---

## Project Structure

```
packages/
  api/           — Hono HTTP API (REST routes)
  catalog/       — Tool definitions, capability map, schemas
  db/            — Drizzle ORM schema, migrations, queries
  edge-worker/   — Cloudflare Workers entry point, routing, rate limiting
  exec/          — Execution router, Shopify adapter, safety gating
  ingest/        — Product catalog sync from Shopify Admin API
  manifest/      — agents.json manifest generation
  mcp-server/    — MCP server with tool registration
  reliability/   — Success scoring, nightly reverification
  shared/        — Shared types and utilities
  shopify-auth/  — OAuth, webhook verification, token management
tests/
  integration/   — Cross-package integration tests
docs/            — Documentation
```

---

## Troubleshooting

### "No active manifest for this shop" (404)

The shop has not been synced yet. Trigger a sync:

```bash
curl -X POST http://localhost:3000/admin/shops/SHOP_ID/sync \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

### "Unknown shop endpoint" (404)

The edge worker could not resolve the shop. Verify:
- The `Host` header, `X-Shop-Domain` header, or `/shop/:domain/` path matches a registered shop
- The shop has not been uninstalled (`uninstalledAt` is null)

### "Authentication required" (401)

- For public API routes: no auth needed
- For cart/checkout routes: provide `Authorization: Bearer <token>`
- For admin routes: provide `Authorization: Bearer <ADMIN_API_KEY>`

### "Too many requests" (429)

Rate limit exceeded. Check the `Retry-After` header. Limits:
- Read routes: 200/min per IP
- Write routes: 30/min per token
- Admin routes: 10/min per IP

### Database connection errors

Verify `DATABASE_URL` is correct and the database is accessible. Run `pnpm db:migrate` to ensure schema is up to date.

### MCP connection drops

SSE streams have a 5-minute maximum duration. Reconnect and re-initialize when the stream closes. The server sends `: heartbeat` comments every 30 seconds to keep connections alive.
