/**
 * TTL cache with stale-on-error: the public Arc RPC rate-limits hard
 * (observed HTTP 429 / "request limit reached" on plain reads), so when a
 * refresh fails and a stale value exists, serving stale beats serving a 503.
 * Callers that get `stale: true` surface it via the X-Cache header.
 *
 * M-12 fix: a TTL-expired ("stale") entry used to be deleted only by a
 * successful refetch of that SAME key - never on its own - so the Map only
 * ever grew. A caller that can vary the key (e.g. `/v1/bounties`'s
 * `offset` query param feeding the list cache's `${category}:${offset}:${limit}`
 * key) could grow it without bound. Fixed with a hard cap on tracked keys,
 * evicting the oldest on every write once exceeded.
 *
 * That's a size cap rather than a periodic sweep (the other standard fix)
 * because this runs as a Vercel function as often as it runs as a long-lived
 * Node process (see app.ts) - a background `setInterval` sweep is dead
 * weight on serverless and unreliable across cold starts, whereas piggy-
 * backing eviction on `set` (the operation that already runs on every miss)
 * needs no timer at all.
 */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; freshUntil: number }>();

  constructor(
    private readonly ttlMs: number,
    /** Hard cap on distinct keys tracked at once. Default is generous for a
     * small facade's key spaces (jobIds, a handful of list-filter combos)
     * while still bounding worst-case memory under an adversarial key flood. */
    private readonly maxEntries: number = 5_000,
  ) {}

  async getOrFetch(key: string, fetcher: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.freshUntil > now) return { value: hit.value, stale: false };

    try {
      const value = await fetcher();
      this.remember(key, value, now);
      return { value, stale: false };
    } catch (err) {
      if (hit) return { value: hit.value, stale: true };
      throw err;
    }
  }

  private remember(key: string, value: T, now: number): void {
    // Delete-then-set so a refreshed EXISTING key also moves to the "most
    // recently written" end of Map's insertion order, not just brand-new
    // keys - a plain `.set()` on an existing key would leave its position
    // unchanged, making eviction FIFO-by-first-write only. This makes it
    // FIFO-by-most-recent-write instead, closer to LRU, at the cost of one
    // extra O(1) delete per write.
    this.entries.delete(key);
    this.entries.set(key, { value, freshUntil: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
