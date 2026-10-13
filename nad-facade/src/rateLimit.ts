import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import type { RequestHandler } from "express";
import type { Clock } from "./cache.js";

export type LimiterOptions = {
  /** Burst size, in requests. */
  capacity: number;
  /** Sustained rate, in requests per second. */
  refillPerSecond: number;
  /** Upper bound on tracked clients; the least recently seen are dropped first. */
  maxKeys?: number;
  now?: Clock;
};

export type TakeResult = { allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number };

/** Per-key token bucket. In-memory: each serverless instance enforces its own budget (best effort). */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly maxKeys: number;
  private readonly now: Clock;
  private lastSweep = 0;

  constructor(private readonly options: LimiterOptions) {
    if (!(options.capacity >= 1) || !(options.refillPerSecond > 0)) throw new Error("Invalid limiter configuration");
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  take(key: string): TakeResult {
    const now = this.now();
    const { capacity, refillPerSecond } = this.options;
    const previous = this.buckets.get(key);
    let tokens = capacity;
    if (previous) {
      tokens = Math.min(capacity, previous.tokens + ((now - previous.at) / 1000) * refillPerSecond);
      this.buckets.delete(key); // re-insert below so Map order tracks recency
    } else {
      this.makeRoom(now);
    }
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerSecond)) };
    }
    tokens -= 1;
    this.buckets.set(key, { tokens, at: now });
    return { allowed: true, remaining: Math.floor(tokens) };
  }

  get size(): number {
    return this.buckets.size;
  }

  private makeRoom(now: number): void {
    if (this.buckets.size < this.maxKeys) return;
    // Buckets that have refilled completely carry no information; drop them (at most every 10 s).
    if (now - this.lastSweep >= 10_000) {
      this.lastSweep = now;
      const { capacity, refillPerSecond } = this.options;
      for (const [key, bucket] of this.buckets) {
        if (bucket.tokens + ((now - bucket.at) / 1000) * refillPerSecond >= capacity) this.buckets.delete(key);
      }
    }
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Expand an IPv6 literal to eight 16-bit groups; undefined if it is not a valid literal. */
export function expandIpv6(address: string): number[] | undefined {
  let text = address.split("%")[0].toLowerCase();
  if (isIP(text) !== 6) return undefined;
  // An embedded IPv4 tail occupies the last two groups.
  const tail = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text =
      text.slice(0, text.length - tail[0].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

/** The limiter key for one address. IPv6 clients share a bucket per /64 so rotating the host part does not help. */
export function normalizeAddress(address: string): string | undefined {
  const text = address.trim();
  const kind = isIP(text.split("%")[0]);
  if (kind === 4) return text;
  if (kind !== 6) return undefined;
  const groups = expandIpv6(text);
  if (!groups) return undefined;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return `v6:${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}`;
}

/**
 * Client identity for rate limiting. On Vercel the first X-Forwarded-For hop is the client (the platform overwrites
 * the header). When the service runs without such a proxy the header is client-controlled, so only run it behind one.
 */
export function clientKey(headers: IncomingHttpHeaders, remoteAddress?: string): string {
  const candidates = [
    firstHeader(headers["x-forwarded-for"])?.split(",")[0],
    firstHeader(headers["x-real-ip"]),
    remoteAddress,
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate.length > 64) continue;
    const key = normalizeAddress(candidate);
    if (key) return key;
  }
  return "unknown";
}

/** Express middleware: 429 with Retry-After once a client exhausts its bucket. */
export function rateLimit(limiter: TokenBucketLimiter, skip: (path: string) => boolean = () => false): RequestHandler {
  return (req, res, next) => {
    if (skip(req.path)) return next();
    const result = limiter.take(clientKey(req.headers, req.socket.remoteAddress));
    if (result.allowed) return next();
    res.set("Retry-After", String(result.retryAfterSeconds));
    res.status(429).json({ error: "Too many requests" });
  };
}
