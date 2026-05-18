import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side IPFS fetcher. Tries Pinata's authenticated gateway first (works
 * instantly for content we pinned ourselves, even before DHT propagation),
 * then falls back to public gateways. Solves the "freshly-pinned CID returns
 * 404 on public gateways for several minutes" problem.
 */

const PUBLIC_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
];

function cidFromUri(u: string): string {
  return u.replace(/^ipfs:\/\//, "").trim();
}

async function tryFetch(url: string, headers: HeadersInit = {}): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { headers, signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const cid = req.nextUrl.searchParams.get("cid");
  if (!cid) {
    return NextResponse.json({ error: "cid query param required" }, { status: 400 });
  }
  const normalized = cidFromUri(cid);

  const jwt = process.env.PINATA_JWT;

  // 1) Pinata authenticated gateway for public-network content we pinned.
  if (jwt) {
    const text = await tryFetch(
      `https://gateway.pinata.cloud/ipfs/${normalized}`,
      { Authorization: `Bearer ${jwt}` },
    );
    if (text !== null) {
      return new NextResponse(text, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
        },
      });
    }

    // 2) Old private uploads: look the file up by CID, then signed URL.
    try {
      const search = await fetch(
        `https://api.pinata.cloud/v3/files/private?cid=${encodeURIComponent(normalized)}`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      if (search.ok) {
        const meta = await search.json() as { data?: { files?: Array<{ id: string }> } };
        const file = meta.data?.files?.[0];
        if (file?.id) {
          const signRes = await fetch(
            `https://api.pinata.cloud/v3/files/private/download_link`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                url: `https://gateway.pinata.cloud/ipfs/${normalized}`,
                expires: 300,
                date: Math.floor(Date.now() / 1000),
                method: "GET",
              }),
            },
          );
          if (signRes.ok) {
            const { data } = await signRes.json() as { data: string };
            const text = await tryFetch(data);
            if (text !== null) {
              return new NextResponse(text, {
                headers: {
                  "Content-Type": "text/plain; charset=utf-8",
                  "Cache-Control": "public, s-maxage=60",
                },
              });
            }
          }
        }
      }
    } catch {
      // fall through
    }
  }

  // 2) Fall back to public gateways for content not in our Pinata account.
  for (const gw of PUBLIC_GATEWAYS) {
    const text = await tryFetch(`${gw}${normalized}`);
    if (text !== null) {
      return new NextResponse(text, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
        },
      });
    }
  }

  return NextResponse.json(
    { error: `All gateways failed for ${cid}` },
    { status: 502 },
  );
}
