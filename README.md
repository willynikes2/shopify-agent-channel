# Shopify Agent Channel

AI sales channel for Shopify stores. Exposes product search, cart, and checkout as tools that AI assistants can call via MCP or HTTP.

## What It Does

- **Product discovery** -- AI agents search and browse a store's catalog
- **Cart management** -- agents build carts on behalf of users
- **Native checkout** -- checkout always goes through Shopify (Shop Pay, Apple Pay)
- **Multi-tenant edge routing** -- each store gets its own isolated endpoint

## Tech Stack

- TypeScript monorepo (pnpm workspaces)
- Cloudflare Workers (edge routing, rate limiting)
- PostgreSQL with Drizzle ORM
- MCP server (Streamable HTTP transport)
- Hono HTTP API
- Shopify Admin + Storefront APIs (GraphQL)

## Quick Start

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/your-org/shopify-agent-channel.git
   cd shopify-agent-channel
   pnpm install
   ```

2. Copy `.env.example` to `.env` and fill in your credentials:
   ```
   DATABASE_URL=postgresql://...
   ENCRYPTION_KEY=<32-byte-hex>
   SHOPIFY_API_KEY=<from-partner-dashboard>
   SHOPIFY_API_SECRET=<from-partner-dashboard>
   ADMIN_API_KEY=<random-secret>
   ```

3. Run database migrations:
   ```bash
   pnpm db:migrate
   ```

4. Build all packages:
   ```bash
   pnpm build
   ```

5. Run tests:
   ```bash
   pnpm test
   pnpm test:integration
   ```

6. Start development:
   ```bash
   pnpm dev
   ```

## Documentation

- [Architecture and Security](docs/architecture.md)
- [HTTP API Reference](docs/api.md)
- [MCP Tool Reference](docs/mcp.md)
- [Dev Setup and Runbook](docs/runbook.md)

## Project Structure

```
packages/
  api/           Hono HTTP API
  catalog/       Tool definitions and schemas
  db/            Database schema and migrations
  edge-worker/   Cloudflare Workers entry point
  exec/          Execution router and Shopify adapter
  ingest/        Product catalog sync
  manifest/      agents.json generation
  mcp-server/    MCP server
  reliability/   Success scoring, reverification
  shared/        Shared types
  shopify-auth/  OAuth and webhooks
tests/
  integration/   Cross-package integration tests
```

## Status

Phase 11 complete. Core infrastructure is built and tested.
