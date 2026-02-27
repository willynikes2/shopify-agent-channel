import { describe, expect, it, vi, beforeEach } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Mocks — must be declared before importing the module under test    */
/* ------------------------------------------------------------------ */

const mockTransportHandleRequest = vi.fn();
const mockTransportClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: vi.fn().mockImplementation(() => ({
    handleRequest: mockTransportHandleRequest,
    close: mockTransportClose,
  })),
}));

vi.mock('@shopify-agent-channel/mcp-server', () => ({
  createMCPServer: vi.fn().mockResolvedValue({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import {
  MCP_HEARTBEAT_INTERVAL_MS,
  MCP_MAX_DURATION_MS,
  createMCPHandler,
} from '../mcp/handler.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function makeFakeConfig() {
  return {
    shopId: 'test-shop.myshopify.com',
    db: {} as any,
    router: {} as any,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('MCP Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ---- Constants ------------------------------------------------- */

  it('MCP_HEARTBEAT_INTERVAL_MS is 30 seconds', () => {
    expect(MCP_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });

  it('MCP_MAX_DURATION_MS is 5 minutes', () => {
    expect(MCP_MAX_DURATION_MS).toBe(300_000);
  });

  /* ---- createMCPHandler ------------------------------------------ */

  it('createMCPHandler returns an object with handleRequest method', () => {
    const handler = createMCPHandler(makeFakeConfig());

    expect(handler).toBeDefined();
    expect(typeof handler.handleRequest).toBe('function');
  });

  /* ---- handleRequest — non-SSE response -------------------------- */

  it('handleRequest returns non-SSE response as-is', async () => {
    const plainResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    mockTransportHandleRequest.mockResolvedValueOnce(plainResponse);

    const handler = createMCPHandler(makeFakeConfig());
    const request = new Request('https://example.com/mcp', { method: 'POST' });
    const response = await handler.handleRequest(request);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: true });
  });

  /* ---- handleRequest — SSE response gets wrapped ----------------- */

  it('handleRequest wraps SSE response with heartbeat stream', async () => {
    const encoder = new TextEncoder();
    const sseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: hello\n\n'));
        // Keep stream open (don't close)
      },
    });

    const sseResponse = new Response(sseStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    mockTransportHandleRequest.mockResolvedValueOnce(sseResponse);

    const handler = createMCPHandler(makeFakeConfig());
    const request = new Request('https://example.com/mcp', { method: 'POST' });
    const response = await handler.handleRequest(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    // The body should be a ReadableStream (wrapped)
    expect(response.body).toBeInstanceOf(ReadableStream);
  });
});
