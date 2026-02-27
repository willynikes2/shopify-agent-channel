import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  RateLimiter,
  getRateLimitKey,
  TIER_LIMITS,
  type RateLimitResult,
} from '../middleware/rateLimiter.js';

/* ------------------------------------------------------------------ */
/*  RateLimiter class                                                  */
/* ------------------------------------------------------------------ */

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('allows requests under limit', () => {
    const result = limiter.check('test-key', 100);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(99);
    expect(result.retryAfter).toBe(0);
  });

  it('blocks requests at limit', () => {
    const limit = TIER_LIMITS.read; // 200

    // Exhaust the limit
    for (let i = 0; i < limit; i++) {
      const r = limiter.check('flood-key', limit);
      expect(r.allowed).toBe(true);
    }

    // 201st request should be blocked
    const blocked = limiter.check('flood-key', limit);

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it('resets after window expires', () => {
    vi.useFakeTimers();

    try {
      const limit = 10;
      // Exhaust the limit
      for (let i = 0; i < limit; i++) {
        limiter.check('expire-key', limit);
      }

      // Should be blocked
      expect(limiter.check('expire-key', limit).allowed).toBe(false);

      // Advance past the 60s window
      vi.advanceTimersByTime(61_000);

      // Should be allowed again
      const result = limiter.check('expire-key', limit);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(limit - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks different keys independently', () => {
    const limit = 5;

    // Exhaust key-a
    for (let i = 0; i < limit; i++) {
      limiter.check('key-a', limit);
    }

    // key-a blocked
    expect(limiter.check('key-a', limit).allowed).toBe(false);

    // key-b still allowed
    const result = limiter.check('key-b', limit);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(limit - 1);
  });

  it('respects different limits per tier', () => {
    const adminLimit = TIER_LIMITS.admin; // 10

    // Exhaust admin limit
    for (let i = 0; i < adminLimit; i++) {
      const r = limiter.check('admin-key', adminLimit);
      expect(r.allowed).toBe(true);
    }

    // Should be blocked at 11th
    const blocked = limiter.check('admin-key', adminLimit);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  getRateLimitKey                                                    */
/* ------------------------------------------------------------------ */

describe('getRateLimitKey', () => {
  const testIp = '192.168.1.1';

  it('returns "read:<ip>" for read tier', () => {
    const key = getRateLimitKey('read', testIp, undefined);
    expect(key).toBe(`read:${testIp}`);
  });

  it('returns "write:<16-hex-chars>" for write tier with auth header', () => {
    const key = getRateLimitKey('write', testIp, 'Bearer my-secret-token');
    expect(key).toMatch(/^write:[a-f0-9]{16}$/);
  });

  it('falls back to "write:<ip>" for write tier without auth header', () => {
    const key = getRateLimitKey('write', testIp, undefined);
    expect(key).toBe(`write:${testIp}`);
  });

  it('returns "admin:<ip>" for admin tier', () => {
    const key = getRateLimitKey('admin', testIp, undefined);
    expect(key).toBe(`admin:${testIp}`);
  });

  it('produces different hashes for different tokens', () => {
    const key1 = getRateLimitKey('write', testIp, 'Bearer token-alpha');
    const key2 = getRateLimitKey('write', testIp, 'Bearer token-beta');

    expect(key1).not.toBe(key2);
    // Both should still be valid hex format
    expect(key1).toMatch(/^write:[a-f0-9]{16}$/);
    expect(key2).toMatch(/^write:[a-f0-9]{16}$/);
  });
});
