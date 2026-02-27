import { describe, expect, it, vi } from 'vitest';
import { computeSuccessScore, getSuccessScores } from '../successScore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHOP_ID = 'shop-uuid-1';
const TOOL_NAME = 'search_products';

/** Build a mock tool_run row */
function mockRun(overrides: Partial<{
  status: string;
  latencyMs: number;
  errorCode: string | null;
  createdAt: Date;
}> = {}) {
  return {
    id: crypto.randomUUID(),
    shopId: SHOP_ID,
    toolName: TOOL_NAME,
    status: overrides.status ?? 'success',
    latencyMs: overrides.latencyMs ?? 50,
    errorCode: overrides.errorCode ?? null,
    errorMessage: null,
    createdAt: overrides.createdAt ?? new Date(),
  };
}

function makeDb(runs: ReturnType<typeof mockRun>[] = [], existingScores: any[] = []) {
  return {
    query: {
      toolRuns: {
        findMany: vi.fn().mockResolvedValue(runs),
      },
      successScores: {
        findMany: vi.fn().mockResolvedValue(existingScores),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// computeSuccessScore
// ---------------------------------------------------------------------------

describe('computeSuccessScore', () => {
  it('returns zero totals when no runs exist', async () => {
    const db = makeDb([]);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    expect(result.totalRuns).toBe(0);
    expect(result.successRate).toBe(0);
  });

  it('calculates correct success rate', async () => {
    const runs = [
      mockRun({ status: 'success' }),
      mockRun({ status: 'success' }),
      mockRun({ status: 'success' }),
      mockRun({ status: 'error', errorCode: 'TIMEOUT' }),
    ];
    const db = makeDb(runs);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    expect(result.successRate).toBe(0.75);
    expect(result.totalRuns).toBe(4);
  });

  it('calculates p50 latency (median)', async () => {
    const runs = [
      mockRun({ latencyMs: 10 }),
      mockRun({ latencyMs: 20 }),
      mockRun({ latencyMs: 30 }),
      mockRun({ latencyMs: 40 }),
    ];
    const db = makeDb(runs);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    // Median of [10,20,30,40] = 25
    expect(result.p50LatencyMs).toBe(25);
  });

  it('calculates p95 latency', async () => {
    // 20 runs with latencies 1..20
    const runs = Array.from({ length: 20 }, (_, i) =>
      mockRun({ latencyMs: i + 1 }),
    );
    const db = makeDb(runs);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    // p95 of 1..20: index 18 (0-based) = 19
    expect(result.p95LatencyMs).toBe(19);
  });

  it('groups failure modes by error code', async () => {
    const runs = [
      mockRun({ status: 'error', errorCode: 'TIMEOUT' }),
      mockRun({ status: 'error', errorCode: 'TIMEOUT' }),
      mockRun({ status: 'error', errorCode: 'ADAPTER_ERROR' }),
      mockRun({ status: 'success' }),
    ];
    const db = makeDb(runs);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    expect(result.failureModes).toEqual({
      TIMEOUT: 2,
      ADAPTER_ERROR: 1,
    });
  });

  it('upserts into success_scores table', async () => {
    const db = makeDb([mockRun()]);
    await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    expect(db.insert).toHaveBeenCalled();
  });

  it('returns the computed result object', async () => {
    const runs = [mockRun({ status: 'success', latencyMs: 100 })];
    const db = makeDb(runs);
    const result = await computeSuccessScore(db as any, SHOP_ID, TOOL_NAME, 7);
    expect(result).toMatchObject({
      shopId: SHOP_ID,
      toolName: TOOL_NAME,
      windowDays: 7,
      successRate: 1,
      totalRuns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// getSuccessScores
// ---------------------------------------------------------------------------

describe('getSuccessScores', () => {
  it('returns all scores for a shop', async () => {
    const scores = [
      { toolName: 'search_products', successRate: 0.95, totalRuns: 100 },
      { toolName: 'get_product', successRate: 0.99, totalRuns: 50 },
    ];
    const db = makeDb([], scores);
    const result = await getSuccessScores(db as any, SHOP_ID);
    expect(result).toHaveLength(2);
  });
});
