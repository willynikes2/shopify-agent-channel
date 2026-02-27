// Types-only re-exports — no runtime code, no dependency cycles.
// Source packages own the definitions; shared is a convenience barrel.

export type { Database } from '@shopify-agent-channel/db';

export type { ExecRequest, ExecResult } from '@shopify-agent-channel/exec';

export type {
  ToolDefinition,
  Capability,
  CapabilityMap,
  CapabilityMapMetadata,
} from '@shopify-agent-channel/catalog';

export type {
  ProductSearchResult,
  SearchFilters,
  VariantResult,
} from '@shopify-agent-channel/catalog';

export type { AgentsJson } from '@shopify-agent-channel/manifest';

export type {
  SuccessScoreResult,
  ReverifyReport,
  Regression,
} from '@shopify-agent-channel/reliability';
