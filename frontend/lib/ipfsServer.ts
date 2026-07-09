// Server-only IPFS gateway race — shared by the read-cache route and the pin
// route (which uses it to warm the cache right after pinning, so not even
// the FIRST viewer of freshly-posted content pays gateway latency). Both
// call sites hit the exact same `fetch(url, { next: { revalidate } })`, so
// Next's Data Cache treats them as the same cache entry either way.

const GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
];
const GATEWAY_TIMEOUT_MS = 8_000;
export const IPFS_CACHE_TTL_SEC = 31_536_000; // 1 year — CIDs are content-addressed, immutable

export async function fetchIpfsServerCached(cid: string): Promise<string> {
  const attempts = GATEWAYS.map(async gateway => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
    try {
      const res = await fetch(`${gateway}${cid}`, {
        signal: controller.signal,
        next: { revalidate: IPFS_CACHE_TTL_SEC },
      });
      if (!res.ok) throw new Error(`gateway ${gateway} responded ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  });
  return Promise.any(attempts);
}
