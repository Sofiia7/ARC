// In-memory per-IP token bucket. Sufficient for a single Vercel region in MVP;
// move to Upstash Redis when you need cross-instance state. Capacity and
// refill are tuned for "humans posting bounties", not for bots.
//
// NOTE: each serverless instance has its own bucket map. Burst across instances
// can exceed the cap; we accept that trade-off until Sprint 4.

type Bucket = { tokens: number; updatedAt: number };

const BUCKETS = new Map<string, Bucket>();
const MAX_BUCKETS = 5_000; // hard cap to avoid memory growth

export type RateLimitOptions = {
  /** Bucket capacity (max burst). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
};

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
};

export function consume(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  let b = BUCKETS.get(key);
  if (!b) {
    if (BUCKETS.size >= MAX_BUCKETS) {
      // Drop the oldest 10% — coarse LRU; we don't care about precision.
      let i = 0;
      for (const k of BUCKETS.keys()) {
        BUCKETS.delete(k);
        if (++i >= MAX_BUCKETS / 10) break;
      }
    }
    b = { tokens: opts.capacity, updatedAt: now };
    BUCKETS.set(key, b);
  }

  const elapsed = (now - b.updatedAt) / 1000;
  b.tokens = Math.min(opts.capacity, b.tokens + elapsed * opts.refillPerSecond);
  b.updatedAt = now;

  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
  }
  const retryAfterSec = Math.ceil((1 - b.tokens) / opts.refillPerSecond);
  return { ok: false, remaining: 0, retryAfterSec };
}

/** Pull a stable client identifier from request headers. */
export function clientKey(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
