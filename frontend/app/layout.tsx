import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Navbar } from "@/components/Navbar";
import { BackgroundShader } from "@/components/BackgroundShader";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "ArcBounty — Decentralized Bounty Board on Arc",
  description: "Create and complete bounties with USDC on Arc Network. Powered by ERC-8183 + ERC-8004.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          <BackgroundShader />
          <div className="page">
            <Navbar />
            <main>{children}</main>
          </div>
          <Toaster position="bottom-right" theme="dark" richColors />
        </Providers>
      </body>
    </html>
  );
}
