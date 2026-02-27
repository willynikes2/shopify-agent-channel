import type { Database } from '@shopify-agent-channel/db';
import { toolRuns } from '@shopify-agent-channel/db';
import type { ToolDefinition } from '@shopify-agent-channel/catalog';
import type { ShopifyAdapter } from './adapters/shopify.js';
import type { ExecRequest, ExecResult } from './types.js';

export class ExecutionRouter {
  constructor(
    private readonly adapter: ShopifyAdapter,
    private readonly db: Database,
  ) {}

  async execute(request: ExecRequest, toolDef: ToolDefinition): Promise<ExecResult> {
    const start = Date.now();

    // 1. Auth check
    if (toolDef.requires_auth && !request.authContext.isAuthenticated) {
      const latencyMs = Date.now() - start;
      await this.recordToolRun(request, 'auth_required', latencyMs, {
        code: 'AUTH_REQUIRED',
        message: 'Authentication required for this tool',
      });
      return {
        status: 'auth_required',
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required for this tool' },
        latencyMs,
      };
    }

    // 2. Delegate to adapter
    let result: ExecResult;
    try {
      result = await this.adapter.execute(request.shopId, request.toolName, request.inputs);
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : 'Unknown error';
      await this.recordToolRun(request, 'error', latencyMs, {
        code: 'ADAPTER_ERROR',
        message,
      });
      return {
        status: 'error',
        error: { code: 'ADAPTER_ERROR', message },
        latencyMs,
      };
    }

    const latencyMs = Date.now() - start;

    // 3. Record ToolRun
    await this.recordToolRun(request, result.status, latencyMs, result.error);

    return { ...result, latencyMs };
  }

  private async recordToolRun(
    request: ExecRequest,
    status: string,
    latencyMs: number,
    error?: { code: string; message: string },
  ): Promise<void> {
    await this.db.insert(toolRuns).values({
      shopId: request.shopId,
      toolName: request.toolName,
      inputsJson: request.inputs,
      execMethod: 'adapter',
      status,
      latencyMs,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      agentId: request.authContext.agentId ?? null,
    });
  }
}
