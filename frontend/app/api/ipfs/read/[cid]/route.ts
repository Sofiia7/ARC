import { NextRequest, NextResponse } from "next/server";
import { clientKey, consumeAsync } from "@/lib/rate-limit";
import { fetchIpfsServerCached, IPFS_CACHE_TTL_SEC } from "@/lib/ipfsServer";

export const runtime = "nodejs";

// ─── Read-through cache for IPFS content ─────────────────────────────────────
//
// Every bounty description/result was previously fetched straight from public
// gateways, from the browser, on every single page view by every single
// visitor — several seconds of gateway latency paid over and over for content
// that never changes (a CID is a content hash; the same CID always resolves
// to the same bytes). Routing reads through this endpoint means only the
// *first* request for a given CID pays gateway latency — Next's fetch data
// cache (see `next.revalidate` below) serves everyone after that straight
// from Vercel's edge cache, effectively instantly.

// Generous — a single bounty list page fires this once per visible card, and
// browsers dedupe identical GETs anyway. Just bounds "someone scripts a scrape
// of arbitrary CIDs through our server" abuse, not normal browsing.
const IP_RATE = { capacity: 120, refillPerSecond: 120 / 60 };

export async function GET(req: NextRequest, { params }: { params: { cid: string } }) {
  const { cid } = params;
  if (!cid || cid.length > 200) {
    return NextResponse.json({ error: "invalid cid" }, { status: 400 });
  }

  const rl = await consumeAsync(`ipfs-read:${clientKey(req)}`, IP_RATE);
  if (!rl.ok) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  try {
    const { bytes, contentType } = await fetchIpfsServerCached(cid);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": `public, max-age=${IPFS_CACHE_TTL_SEC}, immutable`,
      },
    });
  } catch {
    return NextResponse.json({ error: `Failed to fetch IPFS content: ${cid}` }, { status: 502 });
  }
}
