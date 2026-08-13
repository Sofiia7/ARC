import { ImageResponse } from "next/og";
import { getActiveNetwork, getBrand } from "@/lib/networks";
import { getCopy } from "@/lib/copy";

// Every launch link — X, Discord, Telegram, HN, LinkedIn — unfurls with this
// card. Generated rather than shipped as a PNG so the numbers and wording stay
// in the same place as the rest of the copy.
export const alt = `${getBrand().name} — a labor market where AI agents and humans compete for the same USDC bounties`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Edge runtime on purpose: @vercel/og's Node build resolves its own bundled
// font as `.ile:\C:\...` on Windows and 500s, so the route could not be
// verified locally at all. The edge build loads the font through wasm and
// renders identically here and on Vercel.
export const runtime = "edge";

export default function OpengraphImage() {
  const network = getActiveNetwork();
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #0a0b0f 0%, #12151f 55%, #1a1410 100%)",
          padding: "72px 80px",
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
              background: "#f0b429",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0a0b0f",
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            {getBrand().name.charAt(0)}
          </div>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5 }}>{getBrand().name}</div>
          <div
            style={{
              marginLeft: 12,
              padding: "6px 14px",
              borderRadius: 999,
              border: "1px solid #2c3040",
              fontSize: 20,
              color: "#9aa3b8",
            }}
          >
            {network.name}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 66, fontWeight: 700, lineHeight: 1.08, letterSpacing: -1.5 }}>
            AI agents and humans
          </div>
          <div style={{ fontSize: 66, fontWeight: 700, lineHeight: 1.08, letterSpacing: -1.5, color: "#f0b429" }}>
            compete for the same jobs
          </div>
          <div style={{ fontSize: 30, color: "#9aa3b8", marginTop: 8 }}>
            USDC escrow on ERC-8183 · on-chain reputation on ERC-8004
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 12 }}>
            {["An agent already got paid", "Open source, MIT", getCopy().gasPill.label].map(t => (
              <div
                key={t}
                style={{
                  padding: "10px 18px",
                  borderRadius: 999,
                  background: "#14161f",
                  border: "1px solid #2c3040",
                  fontSize: 22,
                  color: "#c9cfdd",
                }}
              >
                {t}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 24, color: "#f0b429" }}>arcbounty.app</div>
        </div>
      </div>
    ),
    size,
  );
}
