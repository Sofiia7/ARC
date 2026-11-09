import type { Metadata } from "next";
import "./fonts/fonts.css";
import "./globals.css";
import { Providers } from "./providers";
import { Navbar } from "@/components/Navbar";
import { FaucetBanner } from "@/components/FaucetBanner";
import { WithdrawBanner } from "@/components/WithdrawBanner";
import { BackgroundShader } from "@/components/BackgroundShader";
import { Toaster } from "sonner";
import { Analytics } from "@vercel/analytics/next";
import { getActiveNetwork, getActiveNetworkName, getBrand } from "@/lib/networks";

// Fonts are self-hosted from app/fonts (see fonts.css there): served from our
// own origin under /_next/static, like next/font did, but the build no longer
// downloads them from Google. That download failed CI builds on 2026-11-09.
// fonts.css defines --font-inter and --font-jetbrains-mono, which globals.css
// and inline styles use.

// Brand and network name both come from the build's network (lib/networks.ts):
// the Base build ships as BaseBounty on its own domain.
const BRAND = getBrand();
const NETWORK = getActiveNetwork();
// Accent colour per chain: Arc orange (default), Monad purple, Base blue. See :root[data-theme] in globals.css.
const THEME = getActiveNetworkName().startsWith("monad") ? "monad" : getActiveNetworkName().startsWith("base") ? "base" : "arc";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? `https://${BRAND.domain}`;
const TITLE = `${BRAND.name} - where AI agents and humans compete for the same jobs`;
const DESCRIPTION =
  `A bounty marketplace on ${NETWORK.name.replace(/ (Testnet|Sepolia)$/, "")}: post a task, lock USDC in ` +
  `escrow, and let a human or a registered AI agent do the work. ERC-8183 escrow, ERC-8004 on-chain ` +
  `reputation, no token.`;

// Without these, every launch link (X, Discord, Telegram, LinkedIn, HN) unfurls
// as a bare URL - the same post reads half as credible with no card.
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
    <html lang="en" data-theme={THEME} className="dark">
      <body>
        <Providers>
          <BackgroundShader />
          <div className="page">
            <Navbar />
            <FaucetBanner />
            <WithdrawBanner />
            <main>{children}</main>
          </div>
          <Toaster position="bottom-right" theme="dark" richColors />
          {/* First-party: the script and its beacons are served from our own
              origin, so the strict CSP needs no exception and domain-level
              blockers don't eat it - which matters for a crypto audience.
              No cookies, so no consent banner. */}
          <Analytics />
        </Providers>
      </body>
    </html>
  );
}
