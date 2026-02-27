# Phase 11 — Integration Tests + Docs Design

## Overview

Wire the monorepo together with integration tests that exercise real code paths (mocked DB/Shopify API, no port binding), consolidate shared types as re-exports, and write project documentation including a security/threat model section.

## Components

### 1. Shared Types (Re-export Barrel)

`packages/shared/src/types.ts` — types-only re-exports from source packages. No runtime code, no dependency cycles. shared depends on source packages at the type level only (import type).

Re-exports:
- ExecRequest, ExecResult from exec
- ToolDefinition, Capability, CapabilityMap from catalog
- ProductSearchResult, SearchFilters from catalog
- AgentsJson from manifest
- Database from db
- SuccessScoreResult, ReverifyReport, Regression from reliability

### 2. Integration Tests

All use `app.request()` / `app.fetch()` — in-process, no port binding.

**helpers.ts** — shared factory:
- `makeTestDb(shopOverrides?)` — mock DB seeded with 2 shops, ~5 products each
- `makeTestRouter()` — ExecutionRouter with mocked ShopifyAdapter
- `makeTestEdgeApp()` — createEdgeApp() wired to mock DB/router
- Fresh rate limiter per test (new instance, no shared state)

**mcp-http-parity.test.ts** (~4 tests)
- Contract assertions: both interfaces return same data fields/types, not byte-identical
- search_products via HTTP GET vs MCP tool call → same result contract
- get_product via HTTP GET vs MCP tool call → same product contract

**safety-gating.test.ts** (~5 tests)
- POST /api/cart without auth → 401
- POST /api/cart with Bearer token → 200 + cart_id
- POST /api/cart/:id/checkout with auth → checkout_url
- Rate limiter: exceed write limit → 429 + Retry-After header
- Rate limiter resets between tests (fresh instance)

**full-flow.test.ts** (~5 tests)
- End-to-end: shop + manifest → search → get_product → create_cart → initiate_checkout
- Each step feeds output to next step
- Verify checkout_url returned at end

**multi-tenant.test.ts** (~5 tests)
- 2 shops, different products
- X-Shop-Domain: shop-a → shop A products/manifest
- X-Shop-Domain: shop-b → shop B products/manifest
- Cross-contamination check
- Unknown shop domain → 404

**mcp-transport.test.ts** (~3 tests)
- POST /mcp with JSON-RPC initialize → 200 + correct content-type + session ID header
- Verify SSE response structure aligns with MCP SDK Streamable HTTP transport
- Verify response contains valid JSON-RPC result frame

### 3. Documentation

**docs/architecture.md** — System overview, data flow diagram (Mermaid), multi-tenancy, security/threat model section

**docs/api.md** — Full HTTP API reference, all routes, request/response examples, error codes

**docs/mcp.md** — MCP tool reference, schemas, connection guide, safety levels

**docs/runbook.md** — Dev setup, prerequisites, env vars, Shopify partner account, troubleshooting

**docs/security.md** — Threat model section (also linked from architecture.md):
- Token encryption at rest (AES-256-GCM)
- HMAC webhook verification
- Auth gating on write tools
- Rate limiting per tier
- No payment processing (Shopify checkout only)
- Input validation boundaries

**README.md** — Vision, quick start, tech stack, doc links

## File Structure

```
packages/shared/
  src/types.ts
  src/index.ts
  package.json (workspace type deps)
tests/integration/
  vitest.config.ts
  helpers.ts
  mcp-http-parity.test.ts
  safety-gating.test.ts
  full-flow.test.ts
  multi-tenant.test.ts
  mcp-transport.test.ts
docs/
  architecture.md
  api.md
  mcp.md
  runbook.md
README.md
```
