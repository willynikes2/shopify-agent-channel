## 🔴 Mandatory First Step

Before starting any work:

1. Read `docs/BUILDSHEET.md` fully.
2. Check if `docs/build-sheets/builders-addendum.md` exists.
3. If it exists, merge its instructions into the current phase context.
4. If it doesnt exit stop and let me know. 
5. Identify the active phase.
6. Confirm which phase is being implemented.
7. Do NOT skip phases.
8. Do NOT redesign architecture unless explicitly instructed.

If unsure, ask for clarification before writing code.
---

## What This Project Is

Shopify merchants install our app via OAuth.

We expose an agent endpoint (MCP + HTTP) that allows AI assistants to:

- Browse products
- Build carts
- Initiate checkout

Checkout always uses Shopify native checkout
(Shop Pay / Apple Pay).

This creates a new AI sales channel.

---

## Core Tools (v1)

- `search_products(query, filters)`
- `get_product(product_id)`
- `create_cart(lines[])`
- `initiate_checkout(cart_id)`

---

## Embedded App Requirement (Phase 9.5+)

This project includes a Shopify Embedded Admin App.

Responsibilities:

- OAuth install
- Merchant dashboard
- Plan + billing management
- Agent channel enable toggle
- Display metrics + success score
- Display agent endpoint URLs

The embedded app must:
- Not duplicate core logic
- Not contain execution logic
- Call internal admin endpoints only

---

## Billing Requirement (Phase 10+)

Use Shopify Billing API.

Plans:

- free
- pro
- enterprise

Billing logic must:
- Be server-side
- Validate subscription after confirmation
- Enforce plan limits in execution layer

Never process payments manually.

---

## Non-Goals (v1)

- No generic web crawling
- No headless automation
- No scraping arbitrary websites
- No multi-store orchestration
- No external marketplace integration yet

---

## Tech Stack

- TypeScript monorepo (pnpm workspaces)
- Cloudflare Workers (multi-tenant edge routing)
- Durable Objects (session state)
- PostgreSQL (Drizzle ORM)
- MCP server (TypeScript SDK, SSE)
- HTTP API (Hono)
- Shopify Admin API (GraphQL)
- Shopify Storefront API (GraphQL)
- Shopify Embedded App (Remix + App Bridge)

---

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
  apps/
    shopify-embedded/
  infra/migrations/
  docs/
  tests/integration/

---

## Safety Model

- Read tools: public or rate-limited
- Write tools: require auth
- Checkout confirmation = user completes Shopify checkout

Never bypass Shopify checkout.

---

## Architecture Discipline Rules

- Do not collapse monorepo structure.
- Do not move execution logic into embedded app.
- Do not introduce new platforms.
- Do not introduce scraping or bots.
- Follow BUILDSHEET phase prompts exactly.
- Keep code modular and production-ready.
- Prefer minimal changes over sweeping refactors.

---

## Strategic Direction

This project is:

Agent Performance Infrastructure for Shopify.

It is NOT:
- An advertising engine
- A bot network
- A generic AI scraping tool

Future expansion will occur after Phase 11 completion.

Focus only on current phase deliverables.

---

## If Unsure

Stop and ask for clarification before proceeding.
## Allowed Optimizations (Within Current Phase Only)

Claude is allowed to:

- Improve code structure within the current phase.
- Suggest performance optimizations relevant to the current deliverable.
- Improve type safety and schema clarity.
- Add logging and observability relevant to the phase.
- Improve error handling.
- Suggest minor schema adjustments if clearly beneficial.
- Add comments and documentation.

Claude is NOT allowed to:

- Jump ahead to future phases.
- Introduce new platforms.
- Redesign architecture.
- Add scraping or headless automation.
- Introduce cross-merchant orchestration.
- Add advertising logic.
- Refactor monorepo structure.

If a suggested optimization impacts future phases, Claude must:
1. Explain why.
2. Ask for approval before proceeding.