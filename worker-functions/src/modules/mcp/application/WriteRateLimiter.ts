/**
 * WriteRateLimiter
 *
 * In-memory token-bucket rate limiter for write capabilities.
 * Key = arbitrary string (e.g. "principal:workerId:capability").
 *
 * Adequate for single-instance or low-frequency write paths.
 * For HA deployments with strict limits, replace bucket store with Redis.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export class WriteRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly windowMs: number = 60_000,
    private readonly max: number = 10,
    /** Injectable clock for testing. Defaults to Date.now. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Attempts to consume one unit from the bucket for the given key.
   * Returns { allowed: true } or { allowed: false, retryAfterMs }.
   */
  consume(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const ts = this.now();
    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt < ts) {
      this.buckets.set(key, { count: 1, resetAt: ts + this.windowMs });
      return { allowed: true };
    }

    if (existing.count >= this.max) {
      return { allowed: false, retryAfterMs: existing.resetAt - ts };
    }

    existing.count += 1;
    return { allowed: true };
  }

  /**
   * Removes expired buckets. Call periodically to prevent unbounded memory growth.
   */
  cleanup(): void {
    const ts = this.now();
    for (const [k, v] of this.buckets.entries()) {
      if (v.resetAt < ts) {
        this.buckets.delete(k);
      }
    }
  }
}
