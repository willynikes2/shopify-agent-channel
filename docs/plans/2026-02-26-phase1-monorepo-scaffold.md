# Phase 1 — Monorepo Scaffold + Database Schema Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bootstrap the Shopify Agent Channel TypeScript monorepo with all package directories and a complete PostgreSQL schema via Drizzle ORM.

**Architecture:** pnpm workspaces monorepo with 11 packages under `packages/`. Root holds shared TS config, linting, and workspace scripts. Database layer lives in `packages/db/` using Drizzle ORM targeting Neon/pg-compatible Postgres.

**Tech Stack:** pnpm workspaces, TypeScript 5, Vitest, Drizzle ORM, drizzle-kit, @neondatabase/serverless, drizzle-zod, ESLint, Prettier

---

## Task 1: Root scaffold files

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`

**Step 1: Create pnpm-workspace.yaml**

```yaml
packages:
  - 'packages/*'
```

**Step 2: Create root package.json**

```json
{
  "name": "shopify-agent-channel",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "pnpm --recursive run dev",
    "build": "pnpm --recursive run build",
    "test": "pnpm --recursive run test",
    "lint": "pnpm --recursive run lint",
    "db:migrate": "pnpm --filter @shopify-agent-channel/db run migrate",
    "db:generate": "pnpm --filter @shopify-agent-channel/db run generate"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/node": "^20.14.0",
    "eslint": "^9.5.0",
    "prettier": "^3.3.0"
  }
}
```

**Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

**Step 4: Create .gitignore**

```
node_modules
dist
.wrangler
.env
.env.local
.env.production
*.log
.DS_Store
```

**Step 5: Create .env.example**

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

**Step 6: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json .gitignore .env.example
git commit -m "feat: add root monorepo scaffold files"
```

---

## Task 2: Create all 11 package directories

**Files (per package — pattern repeated 11 times):**
- Create: `packages/<name>/package.json`
- Create: `packages/<name>/tsconfig.json`
- Create: `packages/<name>/src/index.ts`

**Packages to create:**
1. `shared` → `@shopify-agent-channel/shared`
2. `db` → `@shopify-agent-channel/db`
3. `shopify-auth` → `@shopify-agent-channel/shopify-auth`
4. `ingest` → `@shopify-agent-channel/ingest`
5. `catalog` → `@shopify-agent-channel/catalog`
6. `manifest` → `@shopify-agent-channel/manifest`
7. `mcp-server` → `@shopify-agent-channel/mcp-server`
8. `api` → `@shopify-agent-channel/api`
9. `exec` → `@shopify-agent-channel/exec`
10. `reliability` → `@shopify-agent-channel/reliability`
11. `edge-worker` → `@shopify-agent-channel/edge-worker`

**Step 1: Each package.json follows this pattern (example for `shared`):**

```json
{
  "name": "@shopify-agent-channel/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "eslint src"
  }
}
```

**Step 2: Each tsconfig.json extends the base:**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Each src/index.ts is a placeholder:**

```typescript
// @shopify-agent-channel/<name>
// Placeholder — implementation added per phase
export {};
```

**Step 4: Commit**

```bash
git add packages/
git commit -m "feat: scaffold all 11 package directories with placeholder entrypoints"
```

---

## Task 3: Install root dev dependencies

**Step 1: Install from root**

```bash
pnpm install
```

Expected: lockfile created, node_modules at root, no errors.

**Step 2: Verify TypeScript found**

```bash
pnpm tsc --version
```

Expected: `Version 5.x.x`

**Step 3: Commit lockfile**

```bash
git add pnpm-lock.yaml
git commit -m "chore: add pnpm lockfile after initial install"
```

---

## Task 4: Database schema — install deps

**Files:**
- Modify: `packages/db/package.json`

**Step 1: Install db-specific dependencies**

```bash
pnpm --filter @shopify-agent-channel/db add drizzle-orm @neondatabase/serverless
pnpm --filter @shopify-agent-channel/db add -D drizzle-kit drizzle-zod
```

Expected: packages installed in `packages/db/node_modules`, package.json updated.

---

## Task 5: Write database schema

**Files:**
- Create: `packages/db/src/schema.ts`

**Step 1: Write schema.ts with all 5 tables**

```typescript
import {
  pgTable, uuid, text, boolean, timestamp, integer, real, jsonb, uniqueIndex, index
} from 'drizzle-orm/pg-core';

// SHOPS — a Shopify store that installed our app
export const shops = pgTable('shops', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopDomain: text('shop_domain').notNull().unique(),
  shopifyAccessTokenEncrypted: text('shopify_access_token_encrypted').notNull(),
  shopifyScopes: text('shopify_scopes').notNull(),
  shopName: text('shop_name'),
  shopCurrency: text('shop_currency').default('USD'),
  plan: text('plan').notNull().default('starter'),
  agentHostname: text('agent_hostname').unique(),
  agentEnabled: boolean('agent_enabled').default(true),
  installedAt: timestamp('installed_at').defaultNow(),
  uninstalledAt: timestamp('uninstalled_at'),
  lastSyncedAt: timestamp('last_synced_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// PRODUCTS — cached product catalog from Shopify
export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  shopifyProductId: text('shopify_product_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  productType: text('product_type'),
  vendor: text('vendor'),
  tags: text('tags').array(),
  status: text('status').default('active'),
  variantsJson: jsonb('variants_json').notNull(),
  imagesJson: jsonb('images_json'),
  shopifyUpdatedAt: timestamp('shopify_updated_at'),
  syncedAt: timestamp('synced_at').defaultNow(),
}, (table) => ({
  shopProductUnique: uniqueIndex('products_shop_shopify_product_unique').on(table.shopId, table.shopifyProductId),
  shopStatusIdx: index('products_shop_status_idx').on(table.shopId, table.status),
}));

// MANIFESTS
export const manifests = pgTable('manifests', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id),
  version: integer('version').notNull().default(1),
  capabilitiesJson: jsonb('capabilities_json').notNull(),
  toolsJson: jsonb('tools_json').notNull(),
  agentsJson: jsonb('agents_json').notNull(),
  generatedAt: timestamp('generated_at').defaultNow(),
  isActive: boolean('is_active').default(true),
});

// TOOL_RUNS
export const toolRuns = pgTable('tool_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id),
  toolName: text('tool_name').notNull(),
  inputsJson: jsonb('inputs_json'),
  execMethod: text('exec_method').notNull().default('adapter'),
  status: text('status').notNull(),
  latencyMs: integer('latency_ms'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  traceRef: text('trace_ref'),
  agentId: text('agent_id'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  shopToolTimeIdx: index('tool_runs_shop_tool_time_idx').on(table.shopId, table.toolName, table.createdAt),
}));

// SUCCESS_SCORES
export const successScores = pgTable('success_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id),
  toolName: text('tool_name').notNull(),
  windowDays: integer('window_days').notNull().default(7),
  successRate: real('success_rate').notNull(),
  p50LatencyMs: integer('p50_latency_ms'),
  p95LatencyMs: integer('p95_latency_ms'),
  totalRuns: integer('total_runs').notNull(),
  failureModesJson: jsonb('failure_modes_json'),
  lastVerifiedAt: timestamp('last_verified_at'),
  computedAt: timestamp('computed_at').defaultNow(),
}, (table) => ({
  shopToolWindowUnique: uniqueIndex('success_scores_shop_tool_window_unique').on(table.shopId, table.toolName, table.windowDays),
  shopToolIdx: index('success_scores_shop_tool_idx').on(table.shopId, table.toolName),
}));
```

**Step 2: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat: add Drizzle ORM schema with shops, products, manifests, tool_runs, success_scores"
```

---

## Task 6: Write packages/db/src/index.ts

**Files:**
- Modify: `packages/db/src/index.ts`

**Step 1: Replace placeholder with real db module**

```typescript
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.js';

export * from './schema.js';

export type Database = ReturnType<typeof getDb>;

export function getDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}
```

**Step 2: Commit**

```bash
git add packages/db/src/index.ts
git commit -m "feat: add getDb() export and re-export schema from db package"
```

---

## Task 7: Write drizzle.config.ts

**Files:**
- Create: `packages/db/drizzle.config.ts`

**Step 1: Create config**

```typescript
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: '../../infra/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
```

**Step 2: Add db scripts to packages/db/package.json**

Add to scripts:
```json
"generate": "drizzle-kit generate",
"migrate": "drizzle-kit migrate",
"studio": "drizzle-kit studio"
```

**Step 3: Commit**

```bash
git add packages/db/drizzle.config.ts packages/db/package.json
git commit -m "feat: add drizzle.config.ts and db scripts for generate/migrate"
```

---

## Task 8: Generate initial migration

**Files:**
- Create: `infra/migrations/` (auto-generated)

**Step 1: Create infra/migrations directory**

```bash
mkdir -p infra/migrations
```

**Step 2: Generate migration SQL**

```bash
cd packages/db && pnpm drizzle-kit generate --config=drizzle.config.ts
```

Expected: Creates `infra/migrations/0000_initial.sql` with CREATE TABLE statements for all 5 tables.

**Step 3: Verify migration file contains all tables**

Check the generated SQL contains: `CREATE TABLE "shops"`, `CREATE TABLE "products"`, `CREATE TABLE "manifests"`, `CREATE TABLE "tool_runs"`, `CREATE TABLE "success_scores"`.

**Step 4: Commit**

```bash
git add infra/migrations/
git commit -m "feat: generate initial Drizzle migration for all 5 tables"
```

---

## Task 9: Run pnpm build — verify no TypeScript errors

**Step 1: Build all packages from root**

```bash
pnpm --recursive run build
```

Expected: All 11 packages compile with no errors (placeholders are trivial).

**Step 2: If build fails, check tsconfig module resolution**

Common issues:
- `moduleResolution: NodeNext` requires `.js` extensions in imports — placeholders use `export {}` so no imports needed
- Any package with no `build` script → add `"build": "tsc"` to its package.json

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: ensure all packages compile cleanly"
```

---

## Phase 1 Complete ✓

Verification checklist (from BUILDSHEET.md Part 3):
- [ ] `pnpm install` — no errors
- [ ] `pnpm build` — no errors
- [ ] `infra/migrations/0000_*.sql` exists with all 5 tables
- [ ] All 11 package directories present with `src/index.ts`
