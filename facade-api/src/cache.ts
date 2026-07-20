/**
 * TTL cache with stale-on-error: the public Arc RPC rate-limits hard
 * (observed HTTP 429 / "request limit reached" on plain reads), so when a
 * refresh fails and a stale value exists, serving stale beats serving a 503.
 * Callers that get `stale: true` surface it via the X-Cache header.
 */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; freshUntil: number }>();

  constructor(private readonly ttlMs: number) {}

  async getOrFetch(key: string, fetcher: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.freshUntil > now) return { value: hit.value, stale: false };

    try {
      const value = await fetcher();
      this.entries.set(key, { value, freshUntil: now + this.ttlMs });
      return { value, stale: false };
    } catch (err) {
      if (hit) return { value: hit.value, stale: true };
      throw err;
    }
  }
}
