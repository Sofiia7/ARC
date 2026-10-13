export type Clock = () => number;

export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Reject after `ms` without leaving a live timer behind. The underlying work is not cancelled. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type CachedValueOptions<T> = {
  load: () => Promise<T>;
  /** A value younger than this is served without touching the network. */
  ttlMs: number;
  /** Hard cap on one load, enforced with a timer. */
  timeoutMs: number;
  /** When a refresh fails, serve the last good value if it is at most this old. Omit to fail instead. */
  maxStaleMs?: number;
  /** Throw to reject a freshly loaded value. It is never cached. */
  validate?: (value: T) => void;
  onError?: (error: unknown) => void;
  now?: Clock;
};

/**
 * One cached value with request coalescing: concurrent callers share a single load, a failed refresh falls back to
 * the last good value (when allowed) and nothing here ever blocks on a load longer than `timeoutMs`.
 */
export class CachedValue<T> {
  private current?: { value: T; at: number };
  private inflight?: Promise<T>;
  private readonly now: Clock;

  constructor(private readonly options: CachedValueOptions<T>) {
    this.now = options.now ?? Date.now;
  }

  /** @param maxAgeMs accept a cached value only if it is younger than this (defaults to the TTL). */
  async get(maxAgeMs: number = this.options.ttlMs): Promise<T> {
    const cached = this.current;
    if (cached && this.now() - cached.at < maxAgeMs) return cached.value;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    try {
      return await this.inflight;
    } catch (error) {
      const stale = this.current;
      const limit = this.options.maxStaleMs;
      if (stale && limit !== undefined && this.now() - stale.at <= limit) return stale.value;
      throw error;
    }
  }

  /** The cached value and its age, without loading anything. */
  peek(): { value: T; ageMs: number } | undefined {
    return this.current && { value: this.current.value, ageMs: this.now() - this.current.at };
  }

  private async refresh(): Promise<T> {
    try {
      const value = await withTimeout(this.options.load(), this.options.timeoutMs);
      this.options.validate?.(value);
      this.current = { value, at: this.now() };
      return value;
    } catch (error) {
      this.options.onError?.(error);
      throw error;
    }
  }
}

/** A size-bounded map whose entries expire. Oldest entries are evicted first. */
export class TtlMap<K, V> {
  private readonly entries = new Map<K, { value: V; expires: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: Clock = Date.now,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number = this.ttlMs): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expires: this.now() + ttlMs });
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Allows at most `limit` concurrent holders; callers must release exactly once. */
export class Semaphore {
  private held = 0;

  constructor(private readonly limit: number) {}

  tryAcquire(): (() => void) | undefined {
    if (this.held >= this.limit) return undefined;
    this.held++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held--;
    };
  }
}

/**
 * Runs `attempt`; if it has not succeeded after `hedgeAfterMs`, or has already failed, starts one more in parallel. The
 * first success wins and it rejects only when both attempts failed. A one-off network stall is then absorbed by the
 * second attempt instead of costing the caller the whole timeout.
 */
export function hedged<T>(attempt: () => Promise<T>, hedgeAfterMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let started = 0;
    let failed = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const launch = () => {
      if (started >= 2 || settled) return;
      started++;
      Promise.resolve()
        .then(attempt)
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            failed++;
            if (settled) return;
            if (started < 2) {
              clearTimeout(timer);
              launch();
            } else if (failed >= started) {
              settled = true;
              reject(error);
            }
          },
        );
    };
    timer = setTimeout(launch, hedgeAfterMs);
    timer.unref?.();
    launch();
  });
}
