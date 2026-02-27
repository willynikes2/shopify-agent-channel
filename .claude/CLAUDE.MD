# Shopify Agent Channel — Project Instructions

## Read docs/BUILDSHEET.md for full build phases and prompts.

## What This Project Is
Shopify merchants install our app via OAuth. We expose an agent endpoint (MCP + HTTP)
that lets AI assistants browse products, build carts, and initiate checkout — using
Shopify's own checkout (Shop Pay / Apple Pay). A new sales channel with zero ad spend.

## Core Tools (v1)
- search_products(query, filters) → products/variants with price + availability
- get_product(product_id) → full product detail + variants
- create_cart(lines[]) → cart_id + line summary
- initiate_checkout(cart_id) → checkout_url (Shopify native checkout)

## Non-Goals (v1)
- No generic web crawling
- No headless browser automation
- No processing payments ourselves
- No multi-store orchestration yet

## Tech Stack
- TypeScript monorepo (pnpm workspaces)
- Cloudflare Workers (edge, multi-tenant routing)
- Durable Objects (session state)
- PostgreSQL (Neon/Supabase) via Drizzle ORM
- MCP server (TypeScript MCP SDK, SSE transport)
- HTTP API (Hono)
- Shopify Admin API (GraphQL) for product sync
- Shopify Storefront API (GraphQL) for cart + checkout

## Repo Structure
shopify-agent-channel/
  packages/
    edge-worker/
    shopify-auth/
    ingest/
    catalog/
    manifest/
    mcp-server/
    api/
    exec/
    reliability/
    db/
    shared/
  infra/migrations/
  docs/
  tests/integration/

## Safety Model
- Read tools (search, get_product): public or rate-limited
- Write tools (cart, checkout): require auth
- Checkout confirmation = user completing Shopify checkout (Apple Pay / Shop Pay)

## Key Rule
Always check docs/BUILDSHEET.md before starting a new phase.
