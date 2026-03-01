/**
 * In-process rate limiter.
 *
 * LIMITATIONS:
 * - State is per-isolate — does NOT persist across Cloudflare Worker instances.
 * - For production, replace with Durable Objects or KV-backed limiter.
 * - Only CF-Connecting-IP is trusted for client identification.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type RateLimitTier = 'read' | 'write' | 'admin';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number; // seconds, 0 if allowed
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Sliding window duration in milliseconds. */
const WINDOW_MS = 60_000;

/** Max requests per window for each tier. */
export const TIER_LIMITS: Record<RateLimitTier, number> = {
  read: 200,
  write: 30,
  admin: 10,
};

/* ------------------------------------------------------------------ */
/*  RateLimiter                                                        */
/* ------------------------------------------------------------------ */

interface WindowEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private windows = new Map<string, WindowEntry>();

  check(key: string, limit: number): RateLimitResult {
    const now = Date.now();

    // Periodic cleanup: prune expired entries when map grows large
    if (this.windows.size > 10_000) {
      for (const [k, e] of this.windows) {
        if (now - e.windowStart >= WINDOW_MS) this.windows.delete(k);
      }
    }

    const entry = this.windows.get(key);

    // No entry or window expired → start fresh window
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      this.windows.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: limit - 1, retryAfter: 0 };
    }

    // At or over limit → blocked
    if (entry.count >= limit) {
      const elapsed = now - entry.windowStart;
      const retryAfter = Math.ceil((WINDOW_MS - elapsed) / 1000);
      return { allowed: false, remaining: 0, retryAfter };
    }

    // Under limit → increment
    entry.count += 1;
    return {
      allowed: true,
      remaining: limit - entry.count,
      retryAfter: 0,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Key builder                                                        */
/* ------------------------------------------------------------------ */

/**
 * Simple non-crypto deterministic hash.
 * Returns a 16-character hex string.
 */
function simpleHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h2 >>> 0).toString(16).padStart(8, '0') +
    (h1 >>> 0).toString(16).padStart(8, '0')
  );
}

/**
 * Build a rate-limit key from tier, client IP, and optional auth header.
 *
 * - `read`  → `"read:<ip>"`
 * - `admin` → `"admin:<ip>"`
 * - `write` with Bearer token → `"write:<hash>"`
 * - `write` without token → `"write:<ip>"`
 */
export function getRateLimitKey(
  tier: RateLimitTier,
  ip: string,
  authHeader: string | undefined,
): string {
  if (tier === 'write' && authHeader) {
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;
    return `write:${simpleHash(token)}`;
  }

  return `${tier}:${ip}`;
}
