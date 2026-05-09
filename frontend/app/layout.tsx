import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Navbar } from "@/components/Navbar";
import { Toaster } from "sonner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ArcBounty — Decentralized Bounty Board on Arc",
  description: "Create and complete bounties with USDC on Arc Network. Powered by ERC-8183 + ERC-8004.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-gray-950 text-gray-100 min-h-screen antialiased`}>
        <Providers>
          <Navbar />
          <main className="max-w-6xl mx-auto px-4 py-8">{children}</main>
          <Toaster position="bottom-right" theme="dark" richColors />
        </Providers>
      </body>
    </html>
  );
}
