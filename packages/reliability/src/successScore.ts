import { eq, and, gte } from 'drizzle-orm';
import type { Database } from '@shopify-agent-channel/db';
import { toolRuns, successScores } from '@shopify-agent-channel/db';

export interface SuccessScoreResult {
  shopId: string;
  toolName: string;
  windowDays: number;
  successRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalRuns: number;
  failureModes: Record<string, number>;
}

/**
 * Compute success score for a specific tool over a time window.
 * Queries tool_runs, calculates metrics, upserts into success_scores.
 */
export async function computeSuccessScore(
  db: Database,
  shopId: string,
  toolName: string,
  windowDays = 7,
): Promise<SuccessScoreResult> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const runs = await db.query.toolRuns.findMany({
    where: and(
      eq(toolRuns.shopId, shopId),
      eq(toolRuns.toolName, toolName),
      gte(toolRuns.createdAt, since),
    ),
  });

  const totalRuns = runs.length;

  if (totalRuns === 0) {
    const empty: SuccessScoreResult = {
      shopId,
      toolName,
      windowDays,
      successRate: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      totalRuns: 0,
      failureModes: {},
    };
    await upsertScore(db, empty);
    return empty;
  }

  // Success rate
  const successes = runs.filter((r) => r.status === 'success').length;
  const successRate = successes / totalRuns;

  // Latency percentiles
  const latencies = runs
    .map((r) => r.latencyMs)
    .filter((l): l is number => l !== null)
    .sort((a, b) => a - b);

  const p50LatencyMs = percentile(latencies, 0.5);
  const p95LatencyMs = percentile(latencies, 0.95);

  // Failure modes — group non-success runs by errorCode
  const failureModes: Record<string, number> = {};
  for (const run of runs) {
    if (run.status !== 'success' && run.errorCode) {
      failureModes[run.errorCode] = (failureModes[run.errorCode] ?? 0) + 1;
    }
  }

  const result: SuccessScoreResult = {
    shopId,
    toolName,
    windowDays,
    successRate,
    p50LatencyMs,
    p95LatencyMs,
    totalRuns,
    failureModes,
  };

  await upsertScore(db, result);
  return result;
}

/**
 * Get all current success scores for a shop.
 */
export async function getSuccessScores(
  db: Database,
  shopId: string,
): Promise<SuccessScoreResult[]> {
  const rows = await db.query.successScores.findMany({
    where: eq(successScores.shopId, shopId),
  });

  return rows.map((r) => ({
    shopId: r.shopId,
    toolName: r.toolName,
    windowDays: r.windowDays,
    successRate: r.successRate,
    p50LatencyMs: r.p50LatencyMs ?? 0,
    p95LatencyMs: r.p95LatencyMs ?? 0,
    totalRuns: r.totalRuns,
    failureModes: (
      r.failureModesJson !== null &&
      typeof r.failureModesJson === 'object' &&
      !Array.isArray(r.failureModesJson)
    )
      ? (r.failureModesJson as Record<string, number>)
      : {},
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower]!;
  // Linear interpolation
  const weight = idx - lower;
  return Math.round(sorted[lower]! * (1 - weight) + sorted[upper]! * weight);
}

async function upsertScore(db: Database, score: SuccessScoreResult): Promise<void> {
  await db
    .insert(successScores)
    .values({
      shopId: score.shopId,
      toolName: score.toolName,
      windowDays: score.windowDays,
      successRate: score.successRate,
      p50LatencyMs: score.p50LatencyMs,
      p95LatencyMs: score.p95LatencyMs,
      totalRuns: score.totalRuns,
      failureModesJson: score.failureModes,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [successScores.shopId, successScores.toolName, successScores.windowDays],
      set: {
        successRate: score.successRate,
        p50LatencyMs: score.p50LatencyMs,
        p95LatencyMs: score.p95LatencyMs,
        totalRuns: score.totalRuns,
        failureModesJson: score.failureModes,
        computedAt: new Date(),
      },
    });
}
