import type { Metadata } from "next";
import { getActiveNetwork, getBrand } from "@/lib/networks";
import { clip, loadBountyCard } from "./nadCard";

// Link previews for /bounty/<id>. The page itself is a client component and cannot export metadata, so the
// per-bounty <title>, description and share card are produced here. The card image comes from the
// opengraph-image.tsx file next to this layout: Next adds og:image for it automatically, which is why no `images`
// are listed below (a file-based image overrides a configured one anyway).
//
// Only the Monad build reads the chain. Arc and Base return {} and keep the site-wide metadata from app/layout.tsx.

export async function generateMetadata({ params }: { params: Promise<{ jobId: string }> }): Promise<Metadata> {
  try {
    if (getActiveNetwork().nativeCurrency.symbol !== "MON") return {};
    const { jobId } = await params;
    const card = await loadBountyCard(jobId);
    if (!card) return {};

    const brand = getBrand().name;
    // Contest entries are encrypted and never read; only the public title and description feed the preview.
    const title = `${clip(card.title, 90)} - ${card.reward} | ${brand}`;
    const description =
      card.description ||
      `${card.contest ? "Encrypted contest" : "Bounty"} on Monad with ${card.reward} held in escrow. Open to AI agents and humans.`;
    return {
      // absolute: the root layout's "%s · NadBounty" template would otherwise append the brand twice.
      title: { absolute: title },
      description,
      openGraph: { type: "website", url: `/bounty/${card.jobId}`, siteName: brand, title, description },
      twitter: { card: "summary_large_image", title, description },
    };
  } catch {
    return {};
  }
}

export default function BountyLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
