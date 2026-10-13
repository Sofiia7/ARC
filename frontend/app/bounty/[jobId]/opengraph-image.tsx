import { ImageResponse } from "next/og";
import { getActiveNetwork, getBrand } from "@/lib/networks";
import GenericImage from "@/app/opengraph-image";
import { clip, loadBountyCard } from "./nadCard";

// One share card per bounty (Monad build only). Arc and Base, and any bounty that cannot be read, get the same
// site-wide card as before, so a link never unfurls without an image.
export const alt = "A bounty on NadBounty";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Edge for the same reason as app/opengraph-image.tsx (the Node build of @vercel/og cannot find its font on Windows).
export const runtime = "edge";

// Monad palette: the hex values of :root[data-theme="monad"] in app/globals.css, repeated because ImageResponse
// cannot read CSS variables.
const MARK = "#836EF9";
const ACCENT = "#A58CFF";
const CHIP_BORDER = "#2c3040";

/**
 * The site-wide card. On a Monad build this is only the fallback for a bounty that is missing or could not be read
 * right now, so it must not inherit the one-year immutable caching that the site-wide route sends: a transient RPC
 * failure would otherwise pin the generic card to this URL for good.
 */
function genericCard(shortLived: boolean): Response {
  const res = GenericImage();
  if (!shortLived) return res;
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  return new Response(res.body, { status: res.status, headers });
}

export default async function Image({ params }: { params: Promise<{ jobId: string }> }) {
  if (getActiveNetwork().nativeCurrency.symbol !== "MON") return genericCard(false);
  const { jobId } = await params;
  const card = await loadBountyCard(jobId);
  if (!card) return genericCard(true);

  const brand = getBrand();
  const open = card.outcome === "open";
  const chips = [
    { text: card.contest ? "Encrypted contest" : "Bounty", color: "#c9cfdd", border: CHIP_BORDER },
    {
      text: card.status,
      color: open ? "#0a0b0f" : "#c9cfdd",
      border: open ? ACCENT : CHIP_BORDER,
      fill: open ? ACCENT : undefined,
    },
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #0a0b0f 0%, #12151f 55%, #181330 100%)",
          padding: "64px 80px",
          fontFamily: "sans-serif",
          color: "#f4f1ea",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: MARK,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0a0b0f",
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            {brand.name.charAt(0)}
          </div>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5 }}>{brand.name}</div>
          <div
            style={{
              marginLeft: 12,
              padding: "6px 14px",
              borderRadius: 999,
              border: `1px solid ${CHIP_BORDER}`,
              fontSize: 20,
              color: "#9aa3b8",
            }}
          >
            {getActiveNetwork().name}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ display: "flex", gap: 12 }}>
            {chips.map((c) => (
              <div
                key={c.text}
                style={{
                  padding: "8px 18px",
                  borderRadius: 999,
                  background: c.fill ?? "#14161f",
                  border: `1px solid ${c.border}`,
                  fontSize: 22,
                  color: c.color,
                }}
              >
                {c.text}
              </div>
            ))}
          </div>
          <div
            style={{
              fontSize: 58,
              fontWeight: 700,
              lineHeight: 1.12,
              letterSpacing: -1.2,
              wordBreak: "break-word",
            }}
          >
            {clip(card.title, 90)}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -2, color: ACCENT }}>{card.reward}</div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <div style={{ fontSize: 24, color: "#9aa3b8" }}>Open to AI agents and humans</div>
            <div style={{ fontSize: 24, color: ACCENT }}>{brand.domain}</div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      // The status on the card changes over a bounty's life; do not let a CDN pin the first one for a year.
      headers: { "Cache-Control": "public, max-age=0, s-maxage=120, stale-while-revalidate=600" },
    },
  );
}
