# Shopify Agent Channel — Claude Code Build Sheet & Prompt Guide (v2)

## The Vision

AI assistants will shop for people. When someone says "find me Jordans in size 11.5," an agent should be able to search across stores, compare options, and present the best picks — then the user taps Apple Pay and it's done.

**The problem:** Shopify stores aren't agent-compatible today. AI can't reliably search inventory, check availability, build carts, or hand off to checkout programmatically.

**What we're building:** The cooperation layer. A Shopify app that merchants install to make their store fully agent-compatible. Same checkout rails (Shop Pay, Apple Pay), same fraud protection, same merchant trust — but now AI assistants can drive sales through it. A new sales channel with zero ad spend.

**What we're NOT building (v1):** The multi-store orchestrator / comparison agent. That comes after we have merchants onboarded. Right now we make each store individually queryable and purchasable by agents.

---

## How to Use This Document

1. **Master Prompt** — paste into Claude Code first to set context
2. **Phase-by-Phase Build Prompts** — feed sequentially, each builds on the last
3. **Verification Prompts** — validate each phase works
4. **Reference** — architecture decisions, data models, constraints

---

## PART 1: Master Context Prompt

> **Paste this into Claude Code at the start of your session.**

```
You are a senior staff engineer building a production-grade MVP called "Shopify Agent Channel."

## What It Does
Shopify merchants install our app via OAuth. We then expose an agent endpoint (MCP + HTTP JSON API) that lets AI assistants reliably browse products, build carts, and initiate checkout — using Shopify's own checkout (Shop Pay / Apple Pay). The merchant gets a new AI-powered sales channel. The user gets frictionless agent-driven shopping. No new payment rails.

## Core Tools (v1)
- search_products(query, filters) → products/variants with price + availability
- get_product(product_id) → full product detail + variants
- create_cart(lines[]) → cart_id + line summary
- initiate_checkout(cart_id) → checkout_url (Shopify native checkout)

## Optional v1.1
- get_order_status(order_id)
- get_collections() → browse by collection

## Safety Model
- Read tools (search, get_product): public or API-key rate-limited
- Write tools (create_cart, initiate_checkout): require auth + confirmation gating
- Confirmation = user completing Shopify's own checkout (Apple Pay / Shop Pay). We never process payments ourselves.

## Non-Goals (v1)
- No generic web crawling or SCG of arbitrary sites
- No headless browser automation
- No processing payments ourselves — we return a checkout_url, Shopify handles the rest
- No multi-store orchestration layer yet (that's the consumer app later)
- No Tor

## Tech Stack
- TypeScript monorepo (pnpm workspaces)
- Cloudflare Workers (edge entry point, multi-tenant routing by shop)
- Durable Objects (session state, confirmation tokens)
- PostgreSQL (Neon or Supabase) via Drizzle ORM
- MCP server (TypeScript MCP SDK, SSE transport)
- HTTP API (Hono — runs natively on Workers)
- Shopify Admin API (GraphQL) for product data + shop info
- Shopify Storefront API (GraphQL) for cart creation + checkout URL generation
- R2 for traces/artifacts (optional v1)

## Repo Structure
shopify-agent-channel/
  packages/
    edge-worker/              # Cloudflare Worker entry (multi-tenant routing)
    shopify-auth/             # Shopify OAuth install + webhook handling
    ingest/                   # Pull shop info + products from Shopify API
    catalog/                  # Product index, search, capability map
    manifest/                 # agents.json generator
    mcp-server/               # MCP server (dynamic tools from manifest)
    api/                      # Hono HTTP API (mirrors MCP tools)
    exec/                     # Execution router + Shopify adapter
    reliability/              # Success Score + nightly reverify
    db/                       # Drizzle ORM + schema + migrations
    shared/                   # Shared types, utils, constants
  infra/
    migrations/
  docs/
    architecture.md
    api.md
    mcp.md
    runbook.md
  tests/
    integration/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  wrangler.toml

Keep this context for the entire session. I will give you phase-by-phase build instructions.
```

---

## PART 2: Phase-by-Phase Build Prompts

---

### Phase 1 — Monorepo Scaffold + Database Schema

> **Prompt 1.1: Initialize the monorepo**

```
Initialize the Shopify Agent Channel monorepo.

1. Create root directory `shopify-agent-channel/` with:
   - `pnpm-workspace.yaml` listing `packages/*`
   - `package.json` with workspace scripts: `dev`, `build`, `test`, `lint`, `db:migrate`, `db:generate`
   - `tsconfig.base.json` with strict mode, ES2022 target, NodeNext module resolution
   - `.gitignore` (node_modules, dist, .wrangler, .env*, *.log)
   - `.env.example` with placeholders for:
     DATABASE_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL,
     ENCRYPTION_KEY, R2_BUCKET, ADMIN_API_KEY

2. Create package directories each with `package.json` + `tsconfig.json` extending base:
   - packages/shared
   - packages/db
   - packages/shopify-auth
   - packages/ingest
   - packages/catalog
   - packages/manifest
   - packages/mcp-server
   - packages/api
   - packages/exec
   - packages/reliability
   - packages/edge-worker

3. Each package gets `src/index.ts` as entry point (placeholder).

4. Install shared dev deps at root: typescript, vitest, @types/node, eslint, prettier

Do NOT install package-specific deps yet — we add those per phase.
```

> **Prompt 1.2: Database schema**

```
Set up the database layer in `packages/db/`.

Install: drizzle-orm, drizzle-kit, @neondatabase/serverless (or pg), drizzle-zod.

Create `packages/db/src/schema.ts` with these tables:

SHOPS (this is our main entity — a Shopify store that installed our app)
- id: uuid PK default gen_random_uuid()
- shop_domain: text not null unique (e.g. "cool-kicks.myshopify.com")
- shopify_access_token_encrypted: text not null
- shopify_scopes: text not null (comma-separated scopes granted)
- shop_name: text (display name from Shopify)
- shop_currency: text default 'USD'
- plan: text not null default 'starter' (enum: starter, pro, enterprise)
- agent_hostname: text unique nullable (for future CNAME mode, e.g. agent.coolkicks.com)
- agent_enabled: boolean default true
- installed_at: timestamp default now()
- uninstalled_at: timestamp nullable
- last_synced_at: timestamp nullable
- created_at: timestamp default now()
- updated_at: timestamp default now()

PRODUCTS (cached product catalog from Shopify)
- id: uuid PK
- shop_id: uuid FK -> shops.id ON DELETE CASCADE
- shopify_product_id: text not null
- title: text not null
- description: text
- product_type: text
- vendor: text
- tags: text[] (array)
- status: text default 'active' (active, draft, archived)
- variants_json: jsonb not null (array of variants with id, title, price, sku, inventory, option values)
- images_json: jsonb (array of image URLs)
- shopify_updated_at: timestamp
- synced_at: timestamp default now()
- UNIQUE(shop_id, shopify_product_id)

MANIFESTS
- id: uuid PK
- shop_id: uuid FK -> shops.id
- version: integer not null default 1
- capabilities_json: jsonb not null (deterministic Shopify capability set)
- tools_json: jsonb not null (tool definitions array)
- agents_json: jsonb not null (the full agents.json output)
- generated_at: timestamp default now()
- is_active: boolean default true

TOOL_RUNS
- id: uuid PK
- shop_id: uuid FK -> shops.id
- tool_name: text not null
- inputs_json: jsonb
- exec_method: text not null default 'adapter'
- status: text not null (enum: success, failure, timeout, auth_required, confirmation_required)
- latency_ms: integer
- error_code: text nullable
- error_message: text nullable
- trace_ref: text nullable
- agent_id: text nullable (who called it, if identified)
- created_at: timestamp default now()

SUCCESS_SCORES
- id: uuid PK
- shop_id: uuid FK -> shops.id
- tool_name: text not null
- window_days: integer not null default 7
- success_rate: real not null
- p50_latency_ms: integer
- p95_latency_ms: integer
- total_runs: integer not null
- failure_modes_json: jsonb
- last_verified_at: timestamp
- computed_at: timestamp default now()
- UNIQUE(shop_id, tool_name, window_days)

Add indexes:
- shops(shop_domain) unique
- shops(agent_hostname) unique where not null
- products(shop_id, shopify_product_id) unique
- products(shop_id, status) for active product queries
- tool_runs(shop_id, tool_name, created_at)
- success_scores(shop_id, tool_name)

Create `packages/db/src/index.ts` exporting schema + getDb().
Create `packages/db/drizzle.config.ts`.
Generate initial migration SQL in `infra/migrations/`.
```

---

### Phase 2 — Shopify OAuth + Auth

> **Prompt 2.1: Shopify app auth flow**

```
Build the Shopify OAuth install flow in `packages/shopify-auth/`.

Install: @shopify/shopify-api (official Shopify Node library) or implement manually with fetch.

Create `packages/shopify-auth/src/oauth.ts`:

export async function generateInstallUrl(shopDomain: string): Promise<string>
- Builds the Shopify OAuth authorization URL
- Required scopes: read_products, read_product_listings, read_inventory,
  write_checkouts (if available), read_orders (for v1.1)
- Redirect URI points to your callback endpoint

export async function handleOAuthCallback(params: {
  shop: string; code: string; hmac: string; timestamp: string;
}): Promise<{ accessToken: string; scopes: string }>
- Validates HMAC signature (CRITICAL for security)
- Exchanges code for permanent access token
- Returns token + granted scopes

export function verifyShopifyWebhook(body: string, hmacHeader: string, secret: string): boolean
- Validates incoming Shopify webhooks (app/uninstalled, etc.)

Create `packages/shopify-auth/src/encryption.ts`:

export function encryptToken(token: string, key: string): string
export function decryptToken(encrypted: string, key: string): string
- AES-256-GCM encryption for storing access tokens at rest
- Use ENCRYPTION_KEY env var

Create `packages/shopify-auth/src/webhooks.ts`:

export async function handleAppUninstalled(shopDomain: string): Promise<void>
- Sets uninstalled_at on the shop record
- Sets agent_enabled = false
- (Future: cleanup scheduled)

export async function handleProductsUpdate(shopDomain: string, product: any): Promise<void>
- Upserts product in our PRODUCTS table when Shopify sends product update webhooks
- Keeps our catalog fresh between full syncs

Create `packages/shopify-auth/src/index.ts` exporting all.

Write tests: verify HMAC validation logic, verify encrypt/decrypt roundtrip.
```

---

### Phase 3 — Shopify Ingestion (Read Layer)

> **Prompt 3.1: Pull catalog from Shopify API**

```
Build Shopify ingestion in `packages/ingest/`.

Create `packages/ingest/src/shopifyClient.ts`:

A thin GraphQL client for the Shopify Admin API.

export class ShopifyClient {
  constructor(shopDomain: string, accessToken: string)

  async fetchShopInfo(): Promise<{
    name: string;
    currency: string;
    domain: string;
    myshopifyDomain: string;
    plan: string;
  }>

  async fetchProducts(cursor?: string, limit = 50): Promise<{
    products: ShopifyProduct[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>
  // Uses products query with variants, images, inventory

  async fetchCollections(cursor?: string, limit = 50): Promise<{
    collections: ShopifyCollection[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>
}

GraphQL queries should request:
- Products: id, title, description, productType, vendor, tags, status,
  variants(first: 100) { id, title, price, sku, inventoryQuantity, selectedOptions { name, value } },
  images(first: 10) { url, altText }
- Shop: name, currencyCode, myshopifyDomain, plan { displayName }

Create `packages/ingest/src/ingestShop.ts`:

export async function ingestShop(shopId: string, db: Database): Promise<IngestResult>

Behavior:
1. Load shop record from DB, decrypt access token
2. Create ShopifyClient
3. Fetch shop info, update shop record (shop_name, shop_currency)
4. Paginate through ALL products (follow cursors until no more pages)
5. For each product: upsert into PRODUCTS table
   - Map Shopify product to our schema
   - Store variants as variants_json (array with id, title, price, sku, inventoryQuantity, options)
   - Store images as images_json
6. Mark products not seen in this sync as archived (soft delete)
7. Update shop.last_synced_at
8. Return: { productsUpserted: number, productsArchived: number, totalVariants: number }

Create `packages/ingest/src/index.ts` exporting ingestShop and ShopifyClient.

Write tests: mock the GraphQL responses and verify product upsert logic,
pagination handling, and archive-on-missing behavior.
```

---

### Phase 4 — Catalog + Capability Map

> **Prompt 4.1: Product search + deterministic capability map**

```
Build the catalog layer in `packages/catalog/`.

Create `packages/catalog/src/search.ts`:

export async function searchProducts(
  db: Database,
  shopId: string,
  query: string,
  filters?: {
    productType?: string;
    vendor?: string;
    minPrice?: number;
    maxPrice?: number;
    size?: string;      // matches against variant option values
    color?: string;     // matches against variant option values
    inStock?: boolean;  // filter to variants with inventoryQuantity > 0
  },
  limit = 20
): Promise<ProductSearchResult[]>

Implementation:
1. Query PRODUCTS table where shop_id = shopId AND status = 'active'
2. Text search: use ILIKE on title, description, tags, vendor, product_type
   (For v1 this is fine. Future: add pg_trgm or full-text search index)
3. Apply filters:
   - price/size/color: filter within variants_json using JSONB operators
   - inStock: check inventoryQuantity > 0 in variants
4. Return results with: productId, title, description, vendor, productType,
   variants (filtered to matching), priceRange { min, max }, primaryImage, available: boolean

Create `packages/catalog/src/capabilityMap.ts`:

export function buildCapabilityMap(shop: Shop, productCount: number): CapabilityMap

This is DETERMINISTIC — no heuristics. Every Shopify store gets the same capability set:

{
  capabilities: [
    { id: "search_products", type: "search", safety: "low", requiresAuth: false },
    { id: "get_product", type: "read", safety: "low", requiresAuth: false },
    { id: "create_cart", type: "cart", safety: "medium", requiresAuth: true },
    { id: "initiate_checkout", type: "checkout", safety: "high", requiresAuth: true, requiresConfirmation: true }
  ],
  metadata: {
    shopName: shop.shop_name,
    currency: shop.shop_currency,
    productCount,
    lastSynced: shop.last_synced_at
  }
}

export function deriveToolDefinitions(capMap: CapabilityMap): ToolDefinition[]

Returns tool definitions with full JSON schemas for each tool's inputs and outputs.

Tool schemas:

search_products:
  input: { query: string (required), filters?: { productType?, vendor?, minPrice?, maxPrice?, size?, color?, inStock? }, limit?: number }
  output: { results: ProductSearchResult[], totalFound: number }

get_product:
  input: { product_id: string (required) }
  output: { product: FullProduct }

create_cart:
  input: { lines: [{ variant_id: string, quantity: number }] (required, min 1 item) }
  output: { cart_id: string, lines: CartLineSummary[], subtotal: string, currency: string }

initiate_checkout:
  input: { cart_id: string (required) }
  output: { checkout_url: string, expires_at?: string }

Write tests for searchProducts with mock product data — verify text matching,
size/color filtering across variant options, and price range filtering.
```

---

### Phase 5 — Manifest Generator

> **Prompt 5.1: agents.json for Shopify stores**

```
Build the manifest generator in `packages/manifest/`.

Create `packages/manifest/src/generateAgentsJson.ts`:

export function generateAgentsJson(config: {
  shop: Shop;
  capabilityMap: CapabilityMap;
  tools: ToolDefinition[];
  baseUrl: string;
}): AgentsJson

Output structure:

{
  "name": "<shop.shop_name> Agent Channel",
  "version": "0.1.0",
  "platform": "shopify",
  "issuer": "shopify-agent-channel",
  "base_url": "<baseUrl>",
  "interfaces": {
    "mcp": { "url": "<baseUrl>/mcp", "transport": "sse" },
    "http": { "base_url": "<baseUrl>/api" }
  },
  "auth": {
    "read": { "mode": "public" },
    "write": {
      "mode": "bearer",
      "description": "Cart and checkout tools require a valid API key or agent token.",
      "confirmation_note": "initiate_checkout returns a checkout_url. The user completes payment via Shopify checkout (Shop Pay / Apple Pay). We never handle payment directly."
    }
  },
  "capabilities": [
    // for each tool, mapped from ToolDefinition:
    {
      "id": "<tool.name>",
      "type": "<tool.type>",
      "safety": "<tool.safety_level>",
      "requires_auth": <boolean>,
      "input_schema": <tool.input_schema>,
      "output_schema": <tool.output_schema>,
      "billing": { "model": "free" }  // v1 all free; billing abstraction comes later
    }
  ],
  "store_info": {
    "currency": "<shop.shop_currency>",
    "product_count": <capabilityMap.metadata.productCount>,
    "last_synced": "<capabilityMap.metadata.lastSynced>"
  },
  "reliability": {
    "nightly_reverify": true,
    "success_score_url": "<baseUrl>/api/success-score"
  }
}

Also create a helper to store manifest in DB:

export async function saveManifest(db, shopId, agentsJson, capMap, tools): Promise<void>
- Deactivate previous manifests for this shop (is_active = false)
- Insert new manifest record

Write test: given a mock shop with 50 products, verify agents.json has 4 capabilities,
correct auth config, and valid store_info.
```

---

### Phase 6 — Execution Router + Shopify Adapter

> **Prompt 6.1: Shopify adapter + execution router**

```
Build the execution layer in `packages/exec/`.

Create `packages/exec/src/types.ts`:

ExecRequest:
  - shopId: string
  - toolName: string
  - inputs: Record<string, any>
  - authContext: { agentId?: string; token?: string; isAuthenticated: boolean }

ExecResult:
  - status: 'success' | 'failure' | 'auth_required' | 'error'
  - data?: any
  - error?: { code: string; message: string }
  - latencyMs: number

Create `packages/exec/src/router.ts`:

export class ExecutionRouter {
  constructor(private adapter: ShopifyAdapter, private db: Database)

  async execute(request: ExecRequest, toolDef: ToolDefinition): Promise<ExecResult>
}

Logic:
1. Check tool safety level + auth requirements
2. If tool requires auth and !authContext.isAuthenticated → return auth_required
3. Delegate to ShopifyAdapter
4. Record ToolRun in DB (shop_id, tool_name, inputs, status, latency, error)
5. Return result

Create `packages/exec/src/adapters/shopify.ts`:

export class ShopifyAdapter {
  constructor(private db: Database)

  async execute(shopId: string, toolName: string, inputs: any): Promise<ExecResult>
}

Tool implementations:

search_products:
  - Use catalog searchProducts() from packages/catalog
  - Returns matching products with variants, prices, availability

get_product:
  - Query PRODUCTS table by shop_id + shopify_product_id
  - Return full product with all variants and images

create_cart:
  - Use Shopify Storefront API: cartCreate mutation
    (requires Storefront Access Token — we'll need to create one during install or use the Storefront API with the Admin token via a Storefront API proxy)
  - Input: lines[{ variant_id (Shopify GID), quantity }]
  - Returns: cart_id, line items with titles/prices, subtotal
  - GraphQL mutation:
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { id checkoutUrl lines(first: 10) { edges { node { ... } } } cost { subtotalAmount { amount currencyCode } } }
        userErrors { field message }
      }
    }

initiate_checkout:
  - Input: cart_id
  - Retrieve cart from Shopify → return the checkoutUrl
  - This URL opens Shopify's native checkout (Shop Pay / Apple Pay)
  - We do NOT process payment. The user completes it themselves.
  - The checkout_url IS the confirmation mechanism.

Note on Storefront API access:
  - During OAuth install, we should also create a Storefront Access Token
    via Admin API: POST /admin/api/2024-01/access_tokens.json
  - Store it alongside the Admin token (also encrypted)
  - Or: use the unauthenticated Storefront API if the store has headless channel enabled

Create `packages/exec/src/index.ts` exporting ExecutionRouter and ShopifyAdapter.

Write tests:
- Router: verify auth gating works, verify ToolRun is recorded
- Adapter: mock Shopify GraphQL responses, verify cart creation returns correct shape,
  verify checkout returns a URL
```

---

### Phase 7 — MCP Server

> **Prompt 7.1: MCP server with Shopify tools**

```
Build the MCP server in `packages/mcp-server/`.

Install: @modelcontextprotocol/sdk

Create `packages/mcp-server/src/index.ts`:

export function createMCPServer(config: {
  shopId: string;
  db: Database;
  router: ExecutionRouter;
}): MCPServer

On initialization:
1. Load the active manifest for the shop
2. Register tools from manifest

Create `packages/mcp-server/src/registerTools.ts`:

export function registerTools(server: MCPServer, manifest: Manifest, router: ExecutionRouter): void

Register these tools (derived from manifest but always these 4 for Shopify):

search_products:
  - description: "Search this store's products by keyword, with optional filters for size, color, price range, and stock availability."
  - input_schema from manifest
  - handler: validates input, calls router.execute()

get_product:
  - description: "Get full details for a specific product including all variants, pricing, images, and availability."
  - handler: validates input, calls router.execute()

create_cart:
  - description: "Create a shopping cart with one or more items. Requires authentication."
  - handler: check auth from MCP context, calls router.execute()

initiate_checkout:
  - description: "Get a checkout URL for a cart. The user completes payment via Shopify checkout (Shop Pay / Apple Pay). Requires authentication."
  - handler: check auth, calls router.execute()
  - IMPORTANT: response should clearly indicate this returns a URL the user must open to complete purchase

Transport: SSE for web deployment.

For each tool handler:
- Read tools: no auth required
- Write tools: extract auth from MCP request metadata/context and pass to router

Write tests: mock manifest, verify 4 tools registered, verify search_products callable with mock data.
```

---

### Phase 8 — HTTP API (Hono)

> **Prompt 8.1: HTTP API with MCP parity**

```
Build the HTTP API in `packages/api/`.

Install: hono

Create `packages/api/src/index.ts`:

Hono app with these routes mirroring every MCP tool:

PUBLIC (read):
  GET  /api/products/search?q=<query>&size=<size>&color=<color>&min_price=<n>&max_price=<n>&in_stock=<bool>&limit=<n>
    → same as MCP search_products
  GET  /api/products/:product_id
    → same as MCP get_product
  GET  /api/success-score
    → returns current success scores for all tools
  GET  /.well-known/agents.json
    → returns active manifest

AUTHENTICATED (write — require Authorization: Bearer <token>):
  POST /api/cart
    Body: { lines: [{ variant_id: string, quantity: number }] }
    → same as MCP create_cart
  POST /api/cart/:cart_id/checkout
    → same as MCP initiate_checkout
    → returns { checkout_url, expires_at? }

ADMIN (internal auth):
  POST /admin/shops
    Body: { shop_domain }
    → manually register a shop (for testing; normal flow is OAuth install)
  POST /admin/shops/:id/sync
    → trigger product sync for a shop
  GET  /admin/shops/:id/manifest
    → view current manifest
  GET  /admin/shops/:id/runs?tool=<name>&limit=<n>
    → view recent tool runs
  POST /internal/reverify
    → trigger nightly re-verification (cron endpoint)

SHOPIFY AUTH ROUTES (for OAuth install flow):
  GET  /auth/shopify
    Query: shop=<domain>
    → redirects to Shopify OAuth
  GET  /auth/shopify/callback
    → handles OAuth callback, stores token, triggers initial sync
  POST /webhooks/shopify
    → handles app/uninstalled and products/update webhooks

Middleware:
- CORS (allow all for v1)
- Request ID
- Shop resolution from Host header, X-Shop-ID header, or path context
- Auth middleware for write routes (Bearer token check)
- Admin auth middleware
- Request logging

Each route handler:
1. Resolve shop
2. Call ExecutionRouter (same as MCP uses)
3. Record ToolRun
4. Return JSON

Write tests: search returns 200, cart without auth returns 401,
agents.json returns valid manifest.
```

---

### Phase 9 — Edge Worker (Multi-tenant Router)

> **Prompt 9.1: Cloudflare Worker**

```
Build the edge worker in `packages/edge-worker/`.

Create `wrangler.toml` at repo root:
name = "shopify-agent-channel"
main = "packages/edge-worker/src/index.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

Create `packages/edge-worker/src/index.ts`:

Cloudflare Worker that routes all requests to the correct shop.

Shop Resolution (in order):
1. Host header → look up shop by agent_hostname
2. X-Shop-Domain header → look up by shop_domain
3. Path prefix /shop/<shop_domain>/... → extract shop from path (hosted mode)
4. No match → 404: { error: "Unknown shop endpoint" }

Routing (once shop is resolved):
- GET  /.well-known/agents.json → serve manifest
- /mcp → MCP server (SSE)
- /api/* → Hono API routes
- /auth/* → Shopify OAuth routes
- /webhooks/* → Shopify webhook handler
- GET  / → JSON welcome message:
  {
    "service": "Shopify Agent Channel",
    "shop": "<shop_name>",
    "agents_json": "/.well-known/agents.json",
    "mcp": "/mcp",
    "api": "/api",
    "docs": "https://docs.shopify-agent-channel.dev"
  }

Rate limiting:
- Read: 200 req/min per IP
- Write: 30 req/min per authenticated agent
- Admin: 10 req/min

For v1, the Worker can directly import and run the Hono app (Hono has native Workers support).
The MCP server can be instantiated per-request for the resolved shop.

For local dev, create an adapter that reads shop config from env or local DB.
```

---

### Phase 10 — Reliability Layer

> **Prompt 10.1: Success Score + Nightly Reverify**

```
Build the reliability layer in `packages/reliability/`.

Create `packages/reliability/src/successScore.ts`:

export async function computeSuccessScore(
  db: Database, shopId: string, toolName: string, windowDays = 7
): Promise<SuccessScoreResult>

1. Query tool_runs for shop + tool in last windowDays
2. Calculate: success_rate, p50_latency_ms, p95_latency_ms, total_runs, failure_modes
3. Upsert into success_scores

export async function getSuccessScores(db, shopId): Promise<SuccessScoreResult[]>

Create `packages/reliability/src/reverifyJob.ts`:

export async function runNightlyReverification(db, router): Promise<ReverifyReport>

For each active shop (agent_enabled = true, uninstalled_at IS NULL):
1. search_products: run with query "test" — verify returns results (or empty without error)
2. get_product: pick a known product ID from our DB — verify returns product data
3. create_cart: create cart with a real variant ID, qty 1 — verify returns cart_id
   (this is a real Shopify cart but nobody checks out, so it's harmless)
4. initiate_checkout: DRY RUN ONLY — verify we CAN retrieve a checkout_url from the cart
   but mark it as synthetic (don't expose to any user)
5. Record each as a ToolRun
6. Recompute success scores
7. If any tool drops below 80% success → flag regression
8. Update last_verified_at

Return: { shopsChecked, toolsVerified, regressions[] }

Write tests: seed mock tool_runs with known patterns, verify score computation.
```

---

### Phase 11 — Integration Tests + Docs

> **Prompt 11.1: Wire together + integration tests**

```
Wire everything together and write integration tests.

1. Create `packages/shared/src/types.ts`:
   All shared types: ToolDefinition, ExecRequest, ExecResult, CapabilityMap,
   ProductSearchResult, CartLine, etc. All packages import from @shopify-agent-channel/shared.

2. Create `tests/integration/mcp-http-parity.test.ts`:
   - Seed a test shop with products
   - Call search_products via MCP → call GET /api/products/search via HTTP → same results
   - Call get_product via MCP → call GET /api/products/:id via HTTP → same data

3. Create `tests/integration/safety-gating.test.ts`:
   - POST /api/cart without auth → 401
   - POST /api/cart with auth → success with cart_id
   - POST /api/cart/:id/checkout with auth → returns checkout_url

4. Create `tests/integration/full-flow.test.ts`:
   - Simulate: OAuth install → sync products → generate manifest → search → add to cart → get checkout URL
   - Verify each step produces expected output

5. Create `tests/integration/multi-tenant.test.ts`:
   - Seed 2 shops
   - Requests with different Host/X-Shop-Domain headers return different manifests and different product catalogs
```

> **Prompt 11.2: Documentation**

```
Write project documentation.

1. `docs/architecture.md`:
   - System overview: Shopify app install → sync → expose agent endpoint
   - Data flow: OAuth → Ingest → Catalog → Manifest → MCP/HTTP → Execute via Shopify APIs
   - Multi-tenancy: one install per shop, routing by hostname
   - Security: read=public, write=auth, checkout=user-confirmed via Shopify
   - Reliability: Success Score + nightly reverify
   - Mermaid diagram of the full flow

2. `docs/api.md`:
   - Full HTTP API reference with all routes
   - Request/response examples for each endpoint
   - Auth explanation
   - Error codes

3. `docs/mcp.md`:
   - MCP tool reference with schemas
   - How to connect an MCP client
   - Safety levels explained

4. `docs/runbook.md`:
   - Local dev setup (prerequisites, env vars, Shopify partner account, test store creation)
   - How to install the app on a dev store
   - How to trigger manual sync
   - How to run reverification
   - How to add a new tool in the future
   - Troubleshooting

5. `README.md` at root:
   - "Shopify Agent Channel: Make your store shoppable by AI assistants"
   - Quick start (6 steps)
   - Link to docs/
   - Tech stack
   - Vision statement: "A new sales channel where AI assistants drive purchases through your existing Shopify checkout."
```

---

## PART 3: Verification Prompts

```
# After Phase 1:
pnpm install && pnpm build — no errors
Run migration against local Postgres — all tables created

# After Phase 2:
pnpm --filter @shopify-agent-channel/shopify-auth test
Verify HMAC validation and encrypt/decrypt roundtrip

# After Phase 3:
pnpm --filter @shopify-agent-channel/ingest test
Mock Shopify GraphQL, verify products are upserted correctly

# After Phase 4:
pnpm --filter @shopify-agent-channel/catalog test
Seed 20 products, search "jordan" with size filter → verify correct results

# After Phase 5:
pnpm --filter @shopify-agent-channel/manifest test
Verify agents.json has 4 capabilities with correct schemas

# After Phase 6:
pnpm --filter @shopify-agent-channel/exec test
Verify auth gating, mock cart creation, mock checkout URL return

# After Phase 7:
pnpm --filter @shopify-agent-channel/mcp-server test
Start MCP server, verify 4 tools listed

# After Phase 8:
curl localhost:8787/.well-known/agents.json → valid manifest
curl localhost:8787/api/products/search?q=jordan → results
curl -X POST localhost:8787/api/cart (no auth) → 401

# After Phase 10:
Seed 20 tool_runs, verify computeSuccessScore returns correct metrics

# After Phase 11:
pnpm test — all pass
Full flow: install → sync → manifest → search "jordans size 11.5" → cart → checkout_url
```

---

## PART 4: Quick Reference

### Architecture at a Glance

```
Merchant installs Shopify app
  → OAuth grants access token
  → We sync their product catalog
  → We generate agents.json manifest
  → We expose MCP + HTTP endpoints

AI Agent calls our endpoint:
  → search_products("jordans", { size: "11.5" })
  → get_product(product_id)
  → create_cart([{ variant_id, qty: 1 }])
  → initiate_checkout(cart_id)
  → Returns checkout_url

User opens checkout_url:
  → Shopify's native checkout
  → Apple Pay / Shop Pay / credit card
  → Done. Order placed. Merchant happy.
```

### Tool Definitions (v1)

| Tool | Safety | Auth Required | Method | What Happens |
|---|---|---|---|---|
| search_products | low | no | local DB query | Search our cached product index |
| get_product | low | no | local DB query | Return full product from cache |
| create_cart | medium | yes | Shopify Storefront API | Creates real Shopify cart |
| initiate_checkout | high | yes | Shopify Storefront API | Returns checkout_url for user to complete |

### Key APIs Used

| API | Purpose | Auth |
|---|---|---|
| Shopify Admin API (GraphQL) | Sync products, shop info, create storefront tokens | OAuth access token |
| Shopify Storefront API (GraphQL) | Cart creation, checkout URL | Storefront access token |

### Environment Variables

```env
DATABASE_URL=postgresql://user:pass@host:5432/shopify_agent_channel
SHOPIFY_API_KEY=your_shopify_app_api_key
SHOPIFY_API_SECRET=your_shopify_app_secret
SHOPIFY_APP_URL=https://your-app.dev
SHOPIFY_SCOPES=read_products,read_product_listings,read_inventory,read_orders
ENCRYPTION_KEY=32-byte-hex-key-for-token-encryption
R2_BUCKET=agent-channel-traces
ADMIN_API_KEY=your_internal_admin_key
```

### Definition of Done

1. **OAuth Install**: Shopify test store installs app → access token stored encrypted
2. **Sync**: Products from test store synced to our DB with variants and inventory
3. **Manifest**: `/.well-known/agents.json` serves 4 tools with correct schemas
4. **MCP + HTTP Parity**: `search_products` via MCP and HTTP return same results
5. **Safety Gating**: `create_cart` without auth → 401; with auth → cart_id returned
6. **Checkout Flow**: `initiate_checkout` returns a real Shopify checkout_url that opens Shop Pay
7. **Success Score**: After 20 runs → `/api/success-score` shows metrics per tool
8. **Multi-tenant**: Two test stores return different catalogs and manifests
9. **The Test**: Search "jordans size 11.5" → results returned → add to cart → get checkout URL → opens Shopify checkout with Apple Pay → done
