# Durable Object Rate Limiter — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the in-process `Map`-based rate limiter with a Cloudflare Durable Object-backed rate limiter that enforces limits globally across all Worker isolates.

**Architecture:** Each rate limit key (tier + IP or token hash) maps to a Durable Object instance. The DO maintains a sliding window counter in-memory with optional KV persistence for recovery. The edge worker calls the DO via `stub.fetch()` on each request to check/increment the counter. This gives true per-key global rate limiting regardless of which isolate handles the request.

**Tech Stack:** Cloudflare Workers, Durable Objects, Hono middleware, TypeScript

**Priority:** High — production blocker. Current in-memory limiter is per-isolate and provides no real protection at scale.

---

## Background

The current rate limiter (`packages/edge-worker/src/middleware/rateLimiter.ts`) stores counters in a `Map` on the `RateLimiter` class instance. Each Cloudflare Worker isolate has its own independent map, so:

- Rate limits reset between requests that hit different isolates
- Effective limit = `configured_limit × N_isolates`
- A distributed attacker can trivially exceed limits
- Even a single client can exceed limits if Cloudflare routes their requests to different edge locations

## Design

### Durable Object: `RateLimiterDO`

- One DO instance per rate-limit key (e.g., `read:203.0.113.1`, `write:<token_hash>`)
- Maintains a sliding window counter in-memory (same algorithm as current `RateLimiter.check()`)
- Exposes a single HTTP endpoint: `POST /check` with JSON body `{ limit: number }`
- Returns `{ allowed: boolean, remaining: number, retryAfter: number }`
- DO auto-evicts from memory after ~10s of inactivity (Cloudflare manages this)
- No persistent storage needed — counters are ephemeral (if DO evicts, window resets, which is acceptable)

### Middleware Integration

- Replace `rateLimiter.check(key, limit)` call with `env.RATE_LIMITER.get(id).fetch(request)`
- The DO id is derived from the rate limit key via `env.RATE_LIMITER.idFromName(key)`
- Timeout: if the DO call takes >500ms, allow the request (fail-open to avoid blocking legitimate traffic)

### Tier Limits (unchanged)

| Tier | Limit | Window |
|------|-------|--------|
| read | 200/min | 60s |
| write | 30/min | 60s |
| admin | 10/min | 60s |

---

## Task 1: Create the RateLimiterDO class

**Files:**
- Create: `packages/edge-worker/src/durable-objects/RateLimiterDO.ts`

The DO class:

```typescript
export class RateLimiterDO {
  private count = 0;
  private windowStart = 0;
  private readonly WINDOW_MS = 60_000;

  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { limit } = await request.json() as { limit: number };
    const now = Date.now();

    // Window expired — reset
    if (now - this.windowStart >= this.WINDOW_MS) {
      this.count = 0;
      this.windowStart = now;
    }

    if (this.count >= limit) {
      const elapsed = now - this.windowStart;
      const retryAfter = Math.ceil((this.WINDOW_MS - elapsed) / 1000);
      return Response.json({ allowed: false, remaining: 0, retryAfter });
    }

    this.count += 1;
    return Response.json({
      allowed: true,
      remaining: limit - this.count,
      retryAfter: 0,
    });
  }
}
```

**Tests:** Unit test the DO class with a mock `DurableObjectState`.

---

## Task 2: Wire the DO into wrangler.toml

**Files:**
- Modify: `packages/edge-worker/wrangler.toml` (or equivalent config)

Add the Durable Object binding:

```toml
[durable_objects]
bindings = [
  { name = "RATE_LIMITER", class_name = "RateLimiterDO" }
]

[[migrations]]
tag = "v1"
new_classes = ["RateLimiterDO"]
```

Export the DO class from the worker entry point.

---

## Task 3: Create DO-backed rate limiter middleware

**Files:**
- Create: `packages/edge-worker/src/middleware/durableRateLimiter.ts`

```typescript
export async function checkRateLimit(
  env: { RATE_LIMITER: DurableObjectNamespace },
  key: string,
  limit: number,
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const id = env.RATE_LIMITER.idFromName(key);
  const stub = env.RATE_LIMITER.get(id);

  try {
    const res = await stub.fetch('https://rate-limiter/check', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    });
    return await res.json();
  } catch {
    // Fail-open: if DO is unavailable, allow the request
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }
}
```

---

## Task 4: Replace in-process limiter in edge-worker app

**Files:**
- Modify: `packages/edge-worker/src/app.ts` (rate limiting middleware section)

Replace the `rateLimiter.check()` call with `checkRateLimit(env, key, limit)`.

The `env` binding needs to be threaded through from the Worker's `fetch` handler. Update `EdgeAppConfig` to accept the `RATE_LIMITER` binding.

Keep the old `RateLimiter` class and `rateLimiter.ts` as a local-dev fallback (when `RATE_LIMITER` binding is not available, fall back to in-process).

---

## Task 5: Integration test

**Files:**
- Create: `packages/edge-worker/src/__tests__/durableRateLimiter.test.ts`

Test scenarios:
- Under limit: requests succeed, remaining decrements
- At limit: request blocked, retryAfter > 0
- Window expiry: counter resets after 60s
- DO failure: fail-open (request allowed)

Use Miniflare or mock the DO namespace for local testing.

---

## Task 6: Update documentation

**Files:**
- Modify: `packages/edge-worker/src/middleware/rateLimiter.ts` — update comment to note this is the local-dev fallback only
- Modify: `docs/architecture.md` — document the DO-backed rate limiting approach

---

## Risk & Rollback

- **Risk:** DO latency adds ~1-5ms per request. Acceptable for rate limiting.
- **Rollback:** If DO issues arise, the middleware falls back to in-process (fail-open). Feature flag via env var `USE_DURABLE_RATE_LIMITER=true/false`.
- **Cost:** Durable Objects bill per request + wall-clock duration. At typical traffic, this is negligible (<$1/month for 100k req/day).
