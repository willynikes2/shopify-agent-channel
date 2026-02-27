# Phase 10 — Reliability Layer Design

## Overview

Success score computation from tool run history + nightly reverification job that exercises all 4 tools per active shop and flags regressions.

## Components

### computeSuccessScore(db, shopId, toolName, windowDays)
- Query tool_runs for shop+tool in last N days
- Calculate: success_rate, p50/p95 latency, total_runs, failure_modes
- Upsert into success_scores table

### getSuccessScores(db, shopId)
- Return all success_scores for a shop

### runNightlyReverification(db, router)
- For each active shop: run all 4 tools via ExecutionRouter
- Recompute success scores
- Flag regressions (< 80% success rate)
- Update shop.last_verified_at
- Return { shopsChecked, toolsVerified, regressions[] }

## File Structure
```
packages/reliability/src/
  successScore.ts
  reverifyJob.ts
  index.ts
  __tests__/
    successScore.test.ts
    reverifyJob.test.ts
```
