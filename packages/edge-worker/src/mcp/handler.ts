import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMCPServer } from '@shopify-agent-channel/mcp-server';
import type { Database } from '@shopify-agent-channel/db';
import type { ExecutionRouter } from '@shopify-agent-channel/exec';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** SSE heartbeat interval — keeps proxies / CDNs from closing idle connections. */
export const MCP_HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

/** Maximum SSE stream duration — prevents runaway connections. */
export const MCP_MAX_DURATION_MS = 300_000; // 5 minutes

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface MCPHandlerConfig {
  shopId: string;
  db: Database;
  router: ExecutionRouter;
}

/* ------------------------------------------------------------------ */
/*  SSE wrapping                                                       */
/* ------------------------------------------------------------------ */

/**
 * Wraps an SSE response body with:
 *  - periodic `: heartbeat\n\n` comments (keeps the connection alive)
 *  - a hard max-duration cutoff that closes everything cleanly
 */
function wrapSSEWithHeartbeat(
  originalResponse: Response,
  transport: WebStandardStreamableHTTPServerTransport,
  server: Server,
): Response {
  const originalBody = originalResponse.body;
  if (!originalBody) {
    return originalResponse;
  }

  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let maxDurationTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  function cleanup() {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (maxDurationTimer !== undefined) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = undefined;
    }
  }

  async function closeServerAndTransport() {
    try {
      await transport.close();
    } catch {
      /* already closed */
    }
    try {
      await server.close();
    } catch {
      /* already closed */
    }
  }

  const wrappedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      reader = originalBody.getReader();

      // Heartbeat timer
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          /* stream already closed */
          cleanup();
        }
      }, MCP_HEARTBEAT_INTERVAL_MS);

      // Max duration timer
      maxDurationTimer = setTimeout(async () => {
        try {
          controller.enqueue(encoder.encode(': max-duration-reached\n\n'));
          controller.close();
        } catch {
          /* stream already closed */
        }
        cleanup();
        reader?.cancel().catch(() => {});
        await closeServerAndTransport();
      }, MCP_MAX_DURATION_MS);

      // Pipe original body through
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader!.read();
            if (done) {
              cleanup();
              try {
                controller.close();
              } catch {
                /* already closed */
              }
              return;
            }
            try {
              controller.enqueue(value);
            } catch {
              /* stream closed by consumer */
              cleanup();
              return;
            }
          }
        } catch {
          cleanup();
          try {
            controller.error(new Error('Original SSE stream errored'));
          } catch {
            /* already errored / closed */
          }
          await closeServerAndTransport();
        }
      })();
    },

    cancel() {
      cleanup();
      reader?.cancel().catch(() => {});
      closeServerAndTransport().catch(() => {});
    },
  });

  // Preserve original status + headers
  return new Response(wrappedStream, {
    status: originalResponse.status,
    headers: originalResponse.headers,
  });
}

/* ------------------------------------------------------------------ */
/*  Handler factory                                                    */
/* ------------------------------------------------------------------ */

export function createMCPHandler(config: MCPHandlerConfig) {
  return {
    async handleRequest(request: Request): Promise<Response> {
      // 1. Per-request MCP server
      const server = await createMCPServer({
        shopId: config.shopId,
        db: config.db,
        router: config.router,
      });

      // 2. Streamable HTTP transport
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });

      // 3. Connect server to transport
      await server.connect(transport);

      // 4. Handle the incoming request
      const response = await transport.handleRequest(request);

      // 5. If SSE, wrap with heartbeat + max duration
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        return wrapSSEWithHeartbeat(response, transport, server);
      }

      // 6. Non-SSE — return as-is
      return response;
    },
  };
}
