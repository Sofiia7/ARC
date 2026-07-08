import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Navbar } from "@/components/Navbar";
import { FaucetBanner } from "@/components/FaucetBanner";
import { BackgroundShader } from "@/components/BackgroundShader";
import { Toaster } from "sonner";

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

export const metadata: Metadata = {
  title: "ArcBounty — Decentralized Bounty Board on Arc",
  description: "Create and complete bounties with USDC on Arc Network. Powered by ERC-8183 + ERC-8004.",
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
        </Providers>
      </body>
    </html>
  );
}
