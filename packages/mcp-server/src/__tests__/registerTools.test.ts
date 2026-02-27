import { describe, expect, it, vi } from 'vitest';
import { registerTools } from '../registerTools.js';
import type { AgentsJson } from '@shopify-agent-channel/manifest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP_ID = 'shop-uuid-1';

const MOCK_AGENTS_JSON: AgentsJson = {
  name: 'Cool Store Agent Channel',
  version: '0.1.0',
  platform: 'shopify',
  issuer: 'shopify-agent-channel',
  base_url: 'https://cool-store.agent-channel.dev',
  interfaces: {
    mcp: { url: 'https://cool-store.agent-channel.dev/mcp', transport: 'sse' },
    http: { base_url: 'https://cool-store.agent-channel.dev/api' },
  },
  auth: {
    read: { mode: 'public' },
    write: { mode: 'bearer', description: 'Bearer token required', confirmation_note: 'checkout_url returned' },
  },
  capabilities: [
    {
      id: 'search_products',
      type: 'search',
      safety: 'low',
      requires_auth: false,
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' }, filters: { type: 'object' }, limit: { type: 'integer' } },
        required: ['query'],
      },
      output_schema: { type: 'object' },
      billing: { model: 'free' },
    },
    {
      id: 'get_product',
      type: 'read',
      safety: 'low',
      requires_auth: false,
      input_schema: {
        type: 'object',
        properties: { product_id: { type: 'string' } },
        required: ['product_id'],
      },
      output_schema: { type: 'object' },
      billing: { model: 'free' },
    },
    {
      id: 'create_cart',
      type: 'cart',
      safety: 'medium',
      requires_auth: true,
      input_schema: {
        type: 'object',
        properties: { lines: { type: 'array' } },
        required: ['lines'],
      },
      output_schema: { type: 'object' },
      billing: { model: 'free' },
    },
    {
      id: 'initiate_checkout',
      type: 'checkout',
      safety: 'high',
      requires_auth: true,
      input_schema: {
        type: 'object',
        properties: { cart_id: { type: 'string' } },
        required: ['cart_id'],
      },
      output_schema: { type: 'object' },
      billing: { model: 'free' },
    },
  ],
  store_info: { currency: 'USD', product_count: 50, last_synced: null },
  reliability: {
    nightly_reverify: true,
    success_score_url: 'https://cool-store.agent-channel.dev/api/success-score',
  },
};

function makeServer() {
  const setRequestHandler = vi.fn();
  return {
    setRequestHandler,
    // ListTools handler is registered first
    get listToolsHandler() {
      return setRequestHandler.mock.calls[0]?.[1] as (req: unknown) => Promise<unknown>;
    },
    // CallTool handler is registered second
    get callToolHandler() {
      return setRequestHandler.mock.calls[1]?.[1] as (req: unknown) => Promise<unknown>;
    },
  };
}

function makeRouter(
  result = { status: 'success' as const, data: { results: [], totalFound: 0 }, latencyMs: 5 },
) {
  return { execute: vi.fn().mockResolvedValue(result) };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registerTools — registration', () => {
  it('registers exactly 2 request handlers', () => {
    const server = makeServer();
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, makeRouter() as any);
    expect(server.setRequestHandler).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// list tools
// ---------------------------------------------------------------------------

describe('registerTools — list tools', () => {
  it('returns exactly 4 tools', async () => {
    const server = makeServer();
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, makeRouter() as any);

    const { tools } = (await server.listToolsHandler({})) as { tools: unknown[] };

    expect(tools).toHaveLength(4);
  });

  it('returns all 4 expected tool names', async () => {
    const server = makeServer();
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, makeRouter() as any);

    const { tools } = (await server.listToolsHandler({})) as { tools: Array<{ name: string }> };
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(['create_cart', 'get_product', 'initiate_checkout', 'search_products']);
  });

  it('each tool has a non-empty description', async () => {
    const server = makeServer();
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, makeRouter() as any);

    const { tools } = (await server.listToolsHandler({})) as {
      tools: Array<{ name: string; description: string }>;
    };

    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
    }
  });

  it('each tool has an inputSchema', async () => {
    const server = makeServer();
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, makeRouter() as any);

    const { tools } = (await server.listToolsHandler({})) as {
      tools: Array<{ inputSchema: unknown }>;
    };

    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// call tools — delegation
// ---------------------------------------------------------------------------

describe('registerTools — call tools', () => {
  it('calls router.execute with correct shopId, toolName, and inputs', async () => {
    const server = makeServer();
    const router = makeRouter();
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, router as any);

    await server.callToolHandler({
      params: { name: 'search_products', arguments: { query: 'sneakers' } },
    });

    expect(router.execute).toHaveBeenCalledTimes(1);
    const [execRequest] = router.execute.mock.calls[0] as any[];
    expect(execRequest.shopId).toBe(SHOP_ID);
    expect(execRequest.toolName).toBe('search_products');
    expect(execRequest.inputs).toEqual({ query: 'sneakers' });
  });

  it('passes the matching ToolDefinition as second arg to router', async () => {
    const server = makeServer();
    const router = makeRouter();
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, router as any);

    await server.callToolHandler({
      params: { name: 'search_products', arguments: { query: 'shoes' } },
    });

    const [, toolDef] = router.execute.mock.calls[0] as any[];
    expect(toolDef.name).toBe('search_products');
    expect(toolDef.requires_auth).toBe(false);
  });

  it('returns result data as JSON text in content', async () => {
    const server = makeServer();
    const router = makeRouter({ status: 'success', data: { results: [{ id: 'p1' }], totalFound: 1 }, latencyMs: 5 });
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, router as any);

    const result = (await server.callToolHandler({
      params: { name: 'search_products', arguments: { query: 'shoes' } },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    const data = JSON.parse(result.content[0]!.text);
    expect(data.results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// call tools — auth gating
// ---------------------------------------------------------------------------

describe('registerTools — auth context', () => {
  it('sets isAuthenticated: false for auth-required tool with no token', async () => {
    const server = makeServer();
    const router = makeRouter({ status: 'auth_required', data: undefined, latencyMs: 0 });
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, router as any);

    await server.callToolHandler({
      params: { name: 'create_cart', arguments: { lines: [] }, _meta: {} },
    });

    const [execRequest] = router.execute.mock.calls[0] as any[];
    expect(execRequest.authContext.isAuthenticated).toBe(false);
  });

  it('sets isAuthenticated: true when authToken is in _meta', async () => {
    const server = makeServer();
    const router = makeRouter();
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, router as any);

    await server.callToolHandler({
      params: {
        name: 'create_cart',
        arguments: { lines: [] },
        _meta: { authToken: 'bearer_tok_abc123' },
      },
    });

    const [execRequest] = router.execute.mock.calls[0] as any[];
    expect(execRequest.authContext.isAuthenticated).toBe(true);
    expect(execRequest.authContext.token).toBe('bearer_tok_abc123');
  });

  it('public tools are always authenticated regardless of token', async () => {
    const server = makeServer();
    const router = makeRouter();
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, router as any);

    await server.callToolHandler({
      params: { name: 'search_products', arguments: { query: 'shoes' }, _meta: undefined },
    });

    const [execRequest] = router.execute.mock.calls[0] as any[];
    expect(execRequest.authContext.isAuthenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// call tools — error cases
// ---------------------------------------------------------------------------

describe('registerTools — error cases', () => {
  it('returns isError for unknown tool name', async () => {
    const server = makeServer();
    const router = makeRouter();
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, router as any);

    const result = (await server.callToolHandler({
      params: { name: 'nonexistent_tool', arguments: {} },
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(router.execute).not.toHaveBeenCalled();
  });

  it('marks auth_required results as isError', async () => {
    const server = makeServer();
    const router = makeRouter({ status: 'auth_required', data: undefined, latencyMs: 0 });
    registerTools(server as any, MOCK_AGENTS_JSON, SHOP_ID, router as any);

    const result = (await server.callToolHandler({
      params: { name: 'create_cart', arguments: { lines: [] } },
    })) as { isError: boolean };

    expect(result.isError).toBe(true);
  });
});
