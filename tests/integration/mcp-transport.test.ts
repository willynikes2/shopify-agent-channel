import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — must be before imports that pull them in transitively
// ---------------------------------------------------------------------------

// Mock drizzle-orm since createMCPServer imports eq/and for query filters.
// The mock DB's findFirst ignores filter conditions, so these are passthroughs.
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => undefined),
  and: vi.fn((..._args: unknown[]) => undefined),
}));

// Mock the DB schema export — createMCPServer imports `manifests` table ref
vi.mock('@shopify-agent-channel/db', () => ({
  manifests: { shopId: 'shopId', isActive: 'isActive' },
}));

vi.mock('@shopify-agent-channel/shopify-auth', () => ({
  generateInstallUrl: vi.fn(),
  handleOAuthCallback: vi.fn(),
  verifyShopifyWebhook: vi.fn(),
  handleAppUninstalled: vi.fn(),
  handleProductsUpdate: vi.fn(),
}));

vi.mock('@shopify-agent-channel/ingest', () => ({
  ingestShop: vi.fn().mockResolvedValue({ productsUpserted: 0, productsArchived: 0, totalVariants: 0 }),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

// Import from edge-worker's node_modules since the SDK is a workspace-level dep there
import { WebStandardStreamableHTTPServerTransport } from '../../packages/edge-worker/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js';
import { createMCPHandler } from '../../packages/edge-worker/src/mcp/handler.js';
import { createMCPServer } from '../../packages/mcp-server/src/index.js';
import { makeTestDb, makeTestRouter, makeAgentsJson } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a JSON-RPC result from either JSON or SSE response body. */
async function parseJsonRpcResponse(response: Response): Promise<any> {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    // Extract first `data:` line from SSE stream
    const dataLines = text.split('\n').filter((l) => l.startsWith('data:'));
    if (dataLines.length === 0) {
      throw new Error(`No data: lines found in SSE response:\n${text}`);
    }
    return JSON.parse(dataLines[0].replace(/^data:\s*/, ''));
  }

  // Plain JSON
  return response.json();
}

function makeInitRequest(url: string, sessionId?: string): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  return new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.1.0' },
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP Transport — Streamable HTTP', () => {
  let db: ReturnType<typeof makeTestDb>;
  let router: ReturnType<typeof makeTestRouter>;

  const MCP_URL = 'https://cool-kicks.agent-channel.dev/mcp';

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeTestDb();
    router = makeTestRouter();

    db.query.manifests.findFirst.mockResolvedValue({
      id: 'manifest-a',
      shopId: 'shop-a-uuid',
      version: 1,
      capabilitiesJson: {},
      toolsJson: {},
      agentsJson: makeAgentsJson('Cool Kicks', 'https://cool-kicks.agent-channel.dev'),
      generatedAt: new Date(),
      isActive: true,
    });
  });

  it('POST /mcp with JSON-RPC initialize returns 200 + mcp-session-id header', async () => {
    const handler = createMCPHandler({
      shopId: 'shop-a-uuid',
      db: db as any,
      router: router as any,
    });

    const response = await handler.handleRequest(makeInitRequest(MCP_URL));

    expect(response.status).toBe(200);
    const ct = response.headers.get('content-type') ?? '';
    expect(ct.includes('application/json') || ct.includes('text/event-stream')).toBe(true);

    const sessionId = response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
  });

  it('initialize response contains valid JSON-RPC result with server info', async () => {
    const handler = createMCPHandler({
      shopId: 'shop-a-uuid',
      db: db as any,
      router: router as any,
    });

    const response = await handler.handleRequest(makeInitRequest(MCP_URL));
    const body = await parseJsonRpcResponse(response);

    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result).toBeDefined();
    expect(body.result.serverInfo).toBeDefined();
    expect(body.result.serverInfo.name).toBeTruthy();
    expect(body.result.capabilities).toBeDefined();
  });

  it('POST /mcp with tools/list returns 4 tool definitions', async () => {
    // Use createMCPServer + transport directly to maintain session state
    // across multiple requests (the handler creates per-request servers).
    const server = await createMCPServer({
      shopId: 'shop-a-uuid',
      db: db as any,
      router: router as any,
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });

    await server.connect(transport);

    // --- Step 1: Initialize ---
    const initResponse = await transport.handleRequest(makeInitRequest(MCP_URL));
    expect(initResponse.status).toBe(200);

    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const initBody = await initResponse.json();
    expect(initBody.result).toBeDefined();

    // --- Step 2: Send initialized notification ---
    const notifyRequest = new Request(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    const notifyResponse = await transport.handleRequest(notifyRequest);
    // Notifications may return 200, 202, or 204
    expect([200, 202, 204]).toContain(notifyResponse.status);

    // --- Step 3: tools/list ---
    const toolsRequest = new Request(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    const toolsResponse = await transport.handleRequest(toolsRequest);
    expect(toolsResponse.status).toBe(200);

    const body = await parseJsonRpcResponse(toolsResponse);

    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(2);
    expect(body.result).toBeDefined();
    expect(body.result.tools).toHaveLength(4);

    const toolNames = body.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('search_products');
    expect(toolNames).toContain('get_product');
    expect(toolNames).toContain('create_cart');
    expect(toolNames).toContain('initiate_checkout');

    // Cleanup
    await transport.close();
    await server.close();
  });
});
