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
  /**
   * M-06: when true, a Redis failure (unreachable, timed out, or a response
   * we can't trust - see upstashFixedWindow's validation) rejects the
   * request instead of falling back to the weaker per-instance in-memory
   * bucket. Set this on routes that gate something costly (IPFS pinning, or
   * anything else that spends money or an external quota) - falling back to
   * `consume()` there would silently turn a real global cap of `capacity`
   * into `capacity x number-of-warm-serverless-instances` for as long as
   * Redis stays down, which for a paid/costly action is effectively no cap
   * at all under sustained abuse. Leave false (default) for cheap read-only
   * routes, where degrading to the in-memory limiter during an outage is an
   * acceptable trade for staying available.
   */
  failClosedOnRedisError?: boolean;
};

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
};

/**
 * @param cost Tokens to consume for this call (default 1). Used for
 *   volume-based limits (e.g. "N bytes per day") where each request's cost
 *   varies instead of always being 1 request.
 */
export function consume(key: string, opts: RateLimitOptions, cost = 1): RateLimitResult {
  const now = Date.now();
  let b = BUCKETS.get(key);
  if (!b) {
    if (BUCKETS.size >= MAX_BUCKETS) {
      // Drop the oldest 10% - coarse LRU; we don't care about precision.
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

  if (b.tokens >= cost) {
    b.tokens -= cost;
    return { ok: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
  }
  const retryAfterSec = Math.ceil((cost - b.tokens) / opts.refillPerSecond);
  return { ok: false, remaining: 0, retryAfterSec };
}

/** Pull a stable client identifier from request headers. */
export function clientKey(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

// ─── Distributed backend (Upstash Redis REST) ────────────────────────────────
// Cross-instance limiting for multi-region/serverless. Uses a fixed-window
// counter via the Upstash REST API - NO extra npm dependency (plain fetch).
// Activates only when both env vars are present; otherwise the in-memory bucket
// above is used. On any Redis error we fail OPEN to the in-memory limiter by
// default, so a Redis outage never takes the API down - except for routes
// that opt into `failClosedOnRedisError` (M-06), where a real global cap
// matters more than availability during the (hopefully rare) outage window.

function upstashConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

// M-06: the fetch below previously had no timeout at all - a slow-but-not-
// erroring Upstash response would hang the caller (and, transitively, an API
// route's whole request) indefinitely.
const UPSTASH_TIMEOUT_MS = 4_000;

async function upstashFixedWindow(key: string, max: number, windowSec: number, cost: number): Promise<RateLimitResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  const windowId = Math.floor(Date.now() / 1000 / windowSec);
  const redisKey = `rl:${key}:${windowId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTASH_TIMEOUT_MS);
  let res: Response;
  try {
    // Pipeline: INCRBY then EXPIRE-if-new. Upstash returns [{result:n},{result:..}].
    res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCRBY", redisKey, String(cost)],
        ["EXPIRE", redisKey, String(windowSec), "NX"],
      ]),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`upstash ${res.status}`);

  // M-06: validate the response shape explicitly. It used to be read as
  // `Number(out[0]?.result ?? 0)` - if the body were ever malformed, or
  // carried an `error` field instead of `result` (which Upstash's pipeline
  // endpoint returns per-command on partial failure), that silently defaulted
  // to 0, meaning "no prior usage" - i.e. the limit check always passes.
  // Any shape we don't recognize must be treated as a failure, not as "0".
  const out: unknown = await res.json();
  if (!Array.isArray(out) || out.length === 0) {
    throw new Error(`upstash: response is not a non-empty array: ${JSON.stringify(out).slice(0, 200)}`);
  }
  const first = out[0] as { result?: unknown } | null | undefined;
  if (typeof first !== "object" || first === null || typeof first.result !== "number") {
    throw new Error(`upstash: malformed pipeline response entry: ${JSON.stringify(first).slice(0, 200)}`);
  }
  const count = first.result;

  if (count <= max) {
    return { ok: true, remaining: Math.max(0, max - count), retryAfterSec: 0 };
  }
  // Time left in the current fixed window.
  const retryAfterSec = windowSec - (Math.floor(Date.now() / 1000) % windowSec);
  return { ok: false, remaining: 0, retryAfterSec: Math.max(1, retryAfterSec) };
}

// M-06: retry-after handed back when a fail-closed route rejects a request
// because Redis itself is the thing that failed - short, since the caller
// should retry soon rather than being told to back off for a long window.
const FAIL_CLOSED_RETRY_AFTER_SEC = 5;

/**
 * Rate-limit a key, preferring the distributed Upstash backend when configured
 * and falling back to the in-memory token bucket otherwise (or on Redis error).
 * The `opts` are reused: window length is derived as capacity / refillPerSecond.
 * @param cost Tokens to consume for this call (default 1) - see `consume()`.
 */
export async function consumeAsync(key: string, opts: RateLimitOptions, cost = 1): Promise<RateLimitResult> {
  if (upstashConfigured()) {
    try {
      const windowSec = Math.max(1, Math.round(opts.capacity / opts.refillPerSecond));
      return await upstashFixedWindow(key, opts.capacity, windowSec, cost);
    } catch (err) {
      if (opts.failClosedOnRedisError) {
        console.error(`[rate-limit] Upstash error for "${key}", failing closed:`, err);
        return { ok: false, remaining: 0, retryAfterSec: FAIL_CLOSED_RETRY_AFTER_SEC };
      }
      // Redis unreachable - fail open to in-memory so the API stays up.
      return consume(key, opts, cost);
    }
  }
  return consume(key, opts, cost);
}
