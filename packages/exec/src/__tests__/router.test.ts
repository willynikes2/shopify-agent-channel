import { describe, expect, it, vi } from 'vitest';
import { ExecutionRouter } from '../router.js';
import type { ExecRequest } from '../types.js';
import type { ToolDefinition } from '@shopify-agent-channel/catalog';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOOL_PUBLIC: ToolDefinition = {
  name: 'search_products',
  type: 'search',
  safety_level: 'low',
  requires_auth: false,
  input_schema: {},
  output_schema: {},
};

const TOOL_AUTH: ToolDefinition = {
  name: 'create_cart',
  type: 'cart',
  safety_level: 'medium',
  requires_auth: true,
  input_schema: {},
  output_schema: {},
};

function makeRequest(overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    shopId: 'shop-uuid-1',
    toolName: 'search_products',
    inputs: { query: 'shoes' },
    authContext: { isAuthenticated: false },
    ...overrides,
  };
}

function makeDb() {
  const values = vi.fn().mockResolvedValue(undefined);
  return {
    insert: vi.fn().mockReturnValue({ values }),
    _values: values,
  };
}

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

describe('ExecutionRouter — auth gating', () => {
  it('returns auth_required when tool requires auth and user is unauthenticated', async () => {
    const db = makeDb();
    const adapter = { execute: vi.fn() };
    const router = new ExecutionRouter(adapter as any, db as any);

    const result = await router.execute(makeRequest({ authContext: { isAuthenticated: false } }), TOOL_AUTH);

    expect(result.status).toBe('auth_required');
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('records ToolRun with auth_required status when gated', async () => {
    const db = makeDb();
    const adapter = { execute: vi.fn() };
    const router = new ExecutionRouter(adapter as any, db as any);

    await router.execute(
      makeRequest({ toolName: 'create_cart', authContext: { isAuthenticated: false } }),
      TOOL_AUTH,
    );

    expect(db.insert).toHaveBeenCalledTimes(1);
    const inserted = db._values.mock.calls[0]![0] as any;
    expect(inserted.status).toBe('auth_required');
    expect(inserted.toolName).toBe('create_cart');
    expect(inserted.shopId).toBe('shop-uuid-1');
  });

  it('allows execution for public tools regardless of auth', async () => {
    const db = makeDb();
    const adapter = { execute: vi.fn().mockResolvedValue({ status: 'success', data: {}, latencyMs: 0 }) };
    const router = new ExecutionRouter(adapter as any, db as any);

    const result = await router.execute(
      makeRequest({ authContext: { isAuthenticated: false } }),
      TOOL_PUBLIC,
    );

    expect(result.status).toBe('success');
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Delegation + ToolRun recording
// ---------------------------------------------------------------------------

describe('ExecutionRouter — successful execution', () => {
  it('delegates to adapter with correct shopId, toolName, inputs', async () => {
    const db = makeDb();
    const adapter = { execute: vi.fn().mockResolvedValue({ status: 'success', data: { results: [] }, latencyMs: 5 }) };
    const router = new ExecutionRouter(adapter as any, db as any);
    const req = makeRequest({ authContext: { isAuthenticated: true } });

    await router.execute(req, TOOL_PUBLIC);

    expect(adapter.execute).toHaveBeenCalledWith('shop-uuid-1', 'search_products', { query: 'shoes' });
  });

  it('returns success result with non-negative latencyMs', async () => {
    const db = makeDb();
    const adapter = { execute: vi.fn().mockResolvedValue({ status: 'success', data: {}, latencyMs: 5 }) };
    const router = new ExecutionRouter(adapter as any, db as any);

    const result = await router.execute(makeRequest({ authContext: { isAuthenticated: false } }), TOOL_PUBLIC);

    expect(result.status).toBe('success');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records ToolRun with success status, shopId, toolName, latencyMs', async () => {
    const db = makeDb();
    const adapter = { execute: vi.fn().mockResolvedValue({ status: 'success', data: {}, latencyMs: 5 }) };
    const router = new ExecutionRouter(adapter as any, db as any);
    const req = makeRequest({ toolName: 'search_products', authContext: { isAuthenticated: false } });

    await router.execute(req, TOOL_PUBLIC);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const inserted = db._values.mock.calls[0]![0] as any;
    expect(inserted.status).toBe('success');
    expect(inserted.shopId).toBe('shop-uuid-1');
    expect(inserted.toolName).toBe('search_products');
    expect(inserted.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('forwards adapter data in the result', async () => {
    const db = makeDb();
    const responseData = { results: [{ id: 'prod-1' }], totalFound: 1 };
    const adapter = { execute: vi.fn().mockResolvedValue({ status: 'success', data: responseData, latencyMs: 5 }) };
    const router = new ExecutionRouter(adapter as any, db as any);

    const result = await router.execute(makeRequest({ authContext: { isAuthenticated: false } }), TOOL_PUBLIC);

    expect(result.data).toEqual(responseData);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('ExecutionRouter — error handling', () => {
  it('records ToolRun with error status when adapter throws', async () => {
    const db = makeDb();
    const adapter = { execute: vi.fn().mockRejectedValue(new Error('Adapter crashed')) };
    const router = new ExecutionRouter(adapter as any, db as any);

    const result = await router.execute(makeRequest({ authContext: { isAuthenticated: false } }), TOOL_PUBLIC);

    expect(result.status).toBe('error');
    const inserted = db._values.mock.calls[0]![0] as any;
    expect(inserted.status).toBe('error');
    expect(inserted.errorMessage).toBe('Adapter crashed');
  });
});
