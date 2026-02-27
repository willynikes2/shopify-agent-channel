import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  real,
  jsonb,
  uniqueIndex,
  index,
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
  lastVerifiedAt: timestamp('last_verified_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// PRODUCTS — cached product catalog from Shopify
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
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
  },
  (table) => [
    uniqueIndex('products_shop_shopify_product_unique').on(
      table.shopId,
      table.shopifyProductId,
    ),
    index('products_shop_status_idx').on(table.shopId, table.status),
  ],
);

// MANIFESTS
export const manifests = pgTable('manifests', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id),
  version: integer('version').notNull().default(1),
  capabilitiesJson: jsonb('capabilities_json').notNull(),
  toolsJson: jsonb('tools_json').notNull(),
  agentsJson: jsonb('agents_json').notNull(),
  generatedAt: timestamp('generated_at').defaultNow(),
  isActive: boolean('is_active').default(true),
});

// TOOL_RUNS
export const toolRuns = pgTable(
  'tool_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id),
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
  },
  (table) => [
    index('tool_runs_shop_tool_time_idx').on(
      table.shopId,
      table.toolName,
      table.createdAt,
    ),
  ],
);

// SUCCESS_SCORES
export const successScores = pgTable(
  'success_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id),
    toolName: text('tool_name').notNull(),
    windowDays: integer('window_days').notNull().default(7),
    successRate: real('success_rate').notNull(),
    p50LatencyMs: integer('p50_latency_ms'),
    p95LatencyMs: integer('p95_latency_ms'),
    totalRuns: integer('total_runs').notNull(),
    failureModesJson: jsonb('failure_modes_json'),
    lastVerifiedAt: timestamp('last_verified_at'),
    computedAt: timestamp('computed_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('success_scores_shop_tool_window_unique').on(
      table.shopId,
      table.toolName,
      table.windowDays,
    ),
    index('success_scores_shop_tool_idx').on(table.shopId, table.toolName),
  ],
);
