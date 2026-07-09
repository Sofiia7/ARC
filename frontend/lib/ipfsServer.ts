// Server-only IPFS gateway race — shared by the read-cache route and the pin
// route (which uses it to warm the cache right after pinning, so not even
// the FIRST viewer of freshly-posted content pays gateway latency). Both
// call sites hit the exact same `fetch(url, { next: { revalidate } })`, so
// Next's Data Cache treats them as the same cache entry either way.
//
// Binary-safe on purpose: this also serves image attachments (pinned via
// pin-file), not just markdown text. Returning bytes + the origin's
// content-type — instead of `.text()` — means one function and one cache
// correctly serves both, and images get the same multi-gateway race +
// forever-cache reads/results text already had (previously <img> pointed
// straight at ipfs.io alone, from the browser, no fallback — if that one
// gateway hadn't yet picked up the content from Pinata's DHT announcement,
// the image just stayed broken for every viewer except the uploader).

const GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
];
const GATEWAY_TIMEOUT_MS = 8_000;
export const IPFS_CACHE_TTL_SEC = 31_536_000; // 1 year — CIDs are content-addressed, immutable

export type IpfsFetchResult = { bytes: ArrayBuffer; contentType: string };

export async function fetchIpfsServerCached(cid: string): Promise<IpfsFetchResult> {
  const attempts = GATEWAYS.map(async gateway => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
    try {
      const res = await fetch(`${gateway}${cid}`, {
        signal: controller.signal,
        next: { revalidate: IPFS_CACHE_TTL_SEC },
      });
      if (!res.ok) throw new Error(`gateway ${gateway} responded ${res.status}`);
      const bytes = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      return { bytes, contentType };
    } finally {
      clearTimeout(timer);
    }
  });
  return Promise.any(attempts);
}
