interface Bucket {
  resetAt: number;
  count: number;
}

export class FixedWindowRateLimiter {
  private buckets = new Map<string, Bucket>();
  private checks = 0;

  constructor(
    private readonly windowMs: number,
    private readonly max: number
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    if (++this.checks % 1024 === 0) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
      }
    }
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && this.buckets.size >= 10_000) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) this.buckets.delete(oldestKey);
      }
      this.buckets.set(key, { resetAt: now + this.windowMs, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    current.count += 1;
    if (current.count <= this.max) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000) };
  }
}
