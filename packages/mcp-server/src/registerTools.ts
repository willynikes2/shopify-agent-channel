import { createHash, timingSafeEqual } from 'crypto';
import { eq } from 'drizzle-orm';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Database } from '@shopify-agent-channel/db';
import { shops } from '@shopify-agent-channel/db';
import type { AgentsJson } from '@shopify-agent-channel/manifest';
import type { ExecutionRouter } from '@shopify-agent-channel/exec';
import type { ToolDefinition } from '@shopify-agent-channel/catalog';

const TOOL_DESCRIPTIONS: Record<string, string> = {
  search_products:
    "Search this store's products by keyword, with optional filters for size, color, price range, and stock availability.",
  get_product:
    'Get full details for a specific product including all variants, pricing, images, and availability.',
  create_cart: 'Create a shopping cart with one or more items. Requires authentication.',
  initiate_checkout:
    'Get a checkout URL for a cart. The user completes payment via Shopify checkout (Shop Pay / Apple Pay). Requires authentication.',
};

export function registerTools(
  server: Server,
  agentsJson: AgentsJson,
  shopId: string,
  router: ExecutionRouter,
  db: Database,
): void {
  // Derive ToolDefinitions from manifest capabilities (needed for auth check in router)
  const toolDefs: ToolDefinition[] = agentsJson.capabilities.map((cap) => ({
    name: cap.id,
    type: cap.type,
    safety_level: cap.safety as 'low' | 'medium' | 'high',
    requires_auth: cap.requires_auth,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input_schema: cap.input_schema as Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_schema: cap.output_schema as Record<string, any>,
  }));

  // ---------------------------------------------------------------------------
  // tools/list — advertise available tools
  // ---------------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: agentsJson.capabilities.map((cap) => ({
      name: cap.id,
      description: TOOL_DESCRIPTIONS[cap.id] ?? cap.id,
      inputSchema: cap.input_schema as object,
    })),
  }));

  // ---------------------------------------------------------------------------
  // tools/call — execute a tool
  // ---------------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const inputs = (request.params.arguments ?? {}) as Record<string, unknown>;
    // _meta is a loose Zod object — extra keys like authToken are preserved
    const meta = request.params._meta as Record<string, unknown> | undefined;
    const authToken = meta?.['authToken'] as string | undefined;

    const toolDef = toolDefs.find((t) => t.name === toolName);
    if (!toolDef) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }

    // Public tools pass through; write tools require a valid API token
    let isAuthenticated = !toolDef.requires_auth;
    if (toolDef.requires_auth) {
      if (!authToken) {
        return {
          content: [{ type: 'text' as const, text: 'Authentication required. Provide a valid API token in _meta.authToken.' }],
          isError: true,
        };
      }
      const tokenHash = createHash('sha256').update(authToken).digest('hex');
      const shop = await db.query.shops.findFirst({
        where: eq(shops.id, shopId),
      });
      if (!shop?.agentApiKeyHash) {
        return {
          content: [{ type: 'text' as const, text: 'No API key configured for this shop.' }],
          isError: true,
        };
      }
      const expected = Buffer.from(shop.agentApiKeyHash, 'hex');
      const actual = Buffer.from(tokenHash, 'hex');
      isAuthenticated = expected.length === actual.length && timingSafeEqual(expected, actual);
      if (!isAuthenticated) {
        return {
          content: [{ type: 'text' as const, text: 'Invalid API token.' }],
          isError: true,
        };
      }
    }

    const result = await router.execute(
      { shopId, toolName, inputs, authContext: { isAuthenticated } },
      toolDef,
    );

    let text: string;
    if (result.status === 'auth_required') {
      text = 'Authentication required. Provide a valid API token in _meta.authToken.';
    } else if (result.status === 'error') {
      text = `Error: ${result.error?.message ?? 'Unknown error'}`;
    } else {
      text = JSON.stringify(result.data, null, 2);
    }

    const isError = result.status === 'error' || result.status === 'auth_required';

    return {
      content: [{ type: 'text' as const, text }],
      ...(isError && { isError: true }),
    };
  });
}
