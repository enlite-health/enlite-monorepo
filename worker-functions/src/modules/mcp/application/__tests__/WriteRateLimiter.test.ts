import { WriteRateLimiter } from '../WriteRateLimiter';

describe('WriteRateLimiter', () => {
  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Creates a limiter with an injectable clock starting at t=0. */
  function makeLimiter(opts: { windowMs?: number; max?: number; startAt?: number } = {}) {
    let t = opts.startAt ?? 0;
    const clock = () => t;
    const advance = (ms: number) => { t += ms; };
    const limiter = new WriteRateLimiter(opts.windowMs ?? 60_000, opts.max ?? 3, clock);
    return { limiter, advance };
  }

  const KEY = 'triage-service:uuid-worker:worker.profile.update';
  const KEY_B = 'triage-service:uuid-worker-b:worker.profile.update';

  // 1. First call always allowed
  it('first consume returns allowed=true', () => {
    const { limiter } = makeLimiter();
    expect(limiter.consume(KEY)).toEqual({ allowed: true });
  });

  // 2. Subsequent calls under limit are allowed
  it('calls under max are all allowed', () => {
    const { limiter } = makeLimiter({ max: 3 });
    expect(limiter.consume(KEY)).toEqual({ allowed: true });
    expect(limiter.consume(KEY)).toEqual({ allowed: true });
    expect(limiter.consume(KEY)).toEqual({ allowed: true });
  });

  // 3. On reaching max, returns allowed=false with retryAfterMs > 0
  it('returns allowed=false when max is reached', () => {
    const { limiter } = makeLimiter({ max: 2, windowMs: 60_000 });
    limiter.consume(KEY); // 1
    limiter.consume(KEY); // 2 — reaches max
    const result = limiter.consume(KEY); // 3 — should block
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  // 4. After window expires, bucket resets and calls are allowed again
  it('resets bucket after window expires', () => {
    const { limiter, advance } = makeLimiter({ max: 1, windowMs: 1000 });
    limiter.consume(KEY); // fills bucket
    const blocked = limiter.consume(KEY);
    expect(blocked.allowed).toBe(false);

    // Advance past window
    advance(1001);

    const allowed = limiter.consume(KEY);
    expect(allowed.allowed).toBe(true);
  });

  // 5. Different keys have independent buckets
  it('different keys have independent buckets', () => {
    const { limiter } = makeLimiter({ max: 1 });
    limiter.consume(KEY);   // fills bucket for KEY
    const blockedA = limiter.consume(KEY);
    expect(blockedA.allowed).toBe(false);

    // KEY_B is independent — should still be allowed
    const allowedB = limiter.consume(KEY_B);
    expect(allowedB.allowed).toBe(true);
  });

  // 6. cleanup() removes expired buckets
  it('cleanup removes expired buckets', () => {
    const { limiter, advance } = makeLimiter({ max: 1, windowMs: 500 });
    limiter.consume(KEY);

    // Before expiry — bucket exists (indirectly: it blocks)
    expect(limiter.consume(KEY).allowed).toBe(false);

    // Advance past expiry
    advance(600);
    limiter.cleanup();

    // After cleanup, bucket is gone — new window starts
    expect(limiter.consume(KEY).allowed).toBe(true);
  });

  // 7. cleanup() does NOT remove active buckets
  it('cleanup keeps non-expired buckets intact', () => {
    const { limiter, advance } = makeLimiter({ max: 10, windowMs: 60_000 });
    limiter.consume(KEY); // count=1, active

    advance(100); // still within window
    limiter.cleanup();

    // Should still track the count (call 8 more times without blocking, total=9)
    for (let i = 0; i < 8; i++) {
      expect(limiter.consume(KEY).allowed).toBe(true);
    }
    // 10th call (count=9, allowed → count becomes 10)
    expect(limiter.consume(KEY).allowed).toBe(true);
    // 11th call — hits max (count=10, 10 >= 10 → blocked)
    expect(limiter.consume(KEY).allowed).toBe(false);
  });

  // 8. retryAfterMs reflects remaining time in window
  it('retryAfterMs is approximately equal to remaining window time', () => {
    const { limiter, advance } = makeLimiter({ max: 1, windowMs: 10_000 });
    limiter.consume(KEY); // fills bucket at t=0, resetAt=10000

    advance(3000); // now t=3000, remaining=7000

    const result = limiter.consume(KEY);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // retryAfterMs should be close to 7000 (exact within the same tick)
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(6900);
      expect(result.retryAfterMs).toBeLessThanOrEqual(7100);
    }
  });
});
