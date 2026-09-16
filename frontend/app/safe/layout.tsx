import type { Metadata } from "next";

// An operator tool for the arbitrator Safe's owners, not a page for visitors:
// keep it out of search results.
export const metadata: Metadata = {
  title: "Arbitrator Safe",
  robots: { index: false, follow: false },
};

export default function SafeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
