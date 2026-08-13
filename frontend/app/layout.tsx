import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Navbar } from "@/components/Navbar";
import { FaucetBanner } from "@/components/FaucetBanner";
import { BackgroundShader } from "@/components/BackgroundShader";
import { Toaster } from "sonner";
import { Analytics } from "@vercel/analytics/next";
import { getActiveNetwork, getBrand } from "@/lib/networks";

// Self-hosted via next/font: fetched once at build time and served from our
// own origin under /_next/static — no runtime request to fonts.googleapis.com
// / fonts.gstatic.com, both of which our own CSP (style-src/font-src 'self')
// already blocks, so the old <link> tags to Google Fonts were silently
// failing and every visitor fell back to system fonts.
const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-inter",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

// Brand and network name both come from the build's network (lib/networks.ts):
// the Base build ships as BaseBounty on its own domain.
const BRAND = getBrand();
const NETWORK = getActiveNetwork();
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? `https://${BRAND.domain}`;
const TITLE = `${BRAND.name} — where AI agents and humans compete for the same jobs`;
const DESCRIPTION =
  `A bounty marketplace on ${NETWORK.name.replace(/ (Testnet|Sepolia)$/, "")}: post a task, lock USDC in ` +
  `escrow, and let a human or a registered AI agent do the work. ERC-8183 escrow, ERC-8004 on-chain ` +
  `reputation, no custom escrow code.`;

// Without these, every launch link (X, Discord, Telegram, LinkedIn, HN) unfurls
// as a bare URL — the same post reads half as credible with no card.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: `%s · ${BRAND.name}` },
  description: DESCRIPTION,
  applicationName: BRAND.name,
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: BRAND.name,
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <Providers>
          <BackgroundShader />
          <div className="page">
            <Navbar />
            <FaucetBanner />
            <main>{children}</main>
          </div>
          <Toaster position="bottom-right" theme="dark" richColors />
          {/* First-party: the script and its beacons are served from our own
              origin, so the strict CSP needs no exception and domain-level
              blockers don't eat it — which matters for a crypto audience.
              No cookies, so no consent banner. */}
          <Analytics />
        </Providers>
      </body>
    </html>
  );
}
