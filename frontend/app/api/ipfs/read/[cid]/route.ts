import { NextRequest, NextResponse } from "next/server";
import { clientKey, consumeAsync } from "@/lib/rate-limit";
import { fetchIpfsServerCached, IPFS_CACHE_TTL_SEC } from "@/lib/ipfsServer";

export const runtime = "nodejs";

// ─── Read-through cache for IPFS content ─────────────────────────────────────
//
// Every bounty description/result was previously fetched straight from public
// gateways, from the browser, on every single page view by every single
// visitor - several seconds of gateway latency paid over and over for content
// that never changes (a CID is a content hash; the same CID always resolves
// to the same bytes). Routing reads through this endpoint means only the
// *first* request for a given CID pays gateway latency - Next's fetch data
// cache (see `next.revalidate` below) serves everyone after that straight
// from Vercel's edge cache, effectively instantly.

// Generous - a single bounty list page fires this once per visible card, and
// browsers dedupe identical GETs anyway. Just bounds "someone scripts a scrape
// of arbitrary CIDs through our server" abuse, not normal browsing.
const IP_RATE = { capacity: 120, refillPerSecond: 120 / 60 };

// ─── H-01: Content-Type allowlist on the way out ────────────────────────────
//
// This route proxies whatever CID a caller asks for - including public IPFS
// content this app never pinned - and previously forwarded the upstream
// gateway's own Content-Type verbatim, with no Content-Disposition. A pinned
// HTML or SVG file then rendered INLINE, same-origin as the real app (full
// script execution), the moment anyone followed a link to it (e.g. an
// `ipfs://` link the markdown sanitizer allows through, rewritten to this
// route by IPFSMarkdownClient's rewriteUrl()) - stored XSS via IPFS content.
//
// Fix: only ever emit a Content-Type from this small safe allowlist. Anything
// else - including text/html and image/svg+xml, both script-capable - is
// forced to application/octet-stream with Content-Disposition: attachment,
// so the browser downloads it instead of rendering it. Allowlisted types get
// Content-Disposition: inline (harmless for images/PDF/JSON/plain text - a
// browser can't execute script by rendering a naked text/plain body inline).
const SAFE_INLINE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/json",
  "text/plain",
]);

export async function GET(req: NextRequest, { params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  if (!cid || cid.length > 200) {
    return NextResponse.json({ error: "invalid cid" }, { status: 400 });
  }

  const rl = await consumeAsync(`ipfs-read:${clientKey(req)}`, IP_RATE);
  if (!rl.ok) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  try {
    const { bytes, contentType } = await fetchIpfsServerCached(cid);

    // Strip any `; charset=...` parameter before checking - the allowlist is
    // keyed on the bare MIME type.
    const normalizedType = contentType.split(";")[0]!.trim().toLowerCase();
    const safe = SAFE_INLINE_CONTENT_TYPES.has(normalizedType);

    // Optional download name from IPFSMarkdownClient (the link text, e.g.
    // "source_bundle.zip"), so a saved attachment keeps its extension. Reduced to a
    // plain file name before it goes near a header: no quotes, no path, no CR/LF.
    const requested = req.nextUrl.searchParams.get("filename") ?? "";
    const fileName = /^[\w .-]{1,96}\.[A-Za-z0-9]{1,8}$/.test(requested) ? requested : null;
    const disposition = safe ? "inline" : "attachment";

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "content-type": safe ? contentType : "application/octet-stream",
        "content-disposition": fileName ? `${disposition}; filename="${fileName}"` : disposition,
        "cache-control": `public, max-age=${IPFS_CACHE_TTL_SEC}, immutable`,
      },
    });
  } catch {
    return NextResponse.json({ error: `Failed to fetch IPFS content: ${cid}` }, { status: 502 });
  }
}
