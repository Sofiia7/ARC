"use client";

import { useState } from "react";
import { useParams, notFound } from "next/navigation";
import Link from "next/link";
import { useReadContract } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, CATEGORIES } from "@/lib/contracts";
import { BountyCard } from "@/components/BountyCard";
import type { BountyMeta } from "@/components/BountyCard";
import { useOpenBounties } from "@/hooks/useBountyMeta";

const PAGE_SIZE = 20n;

const CATEGORY_META: Record<string, { emoji: string; description: string }> = {
  dev:     { emoji: "💻", description: "Smart contracts, frontend, backend, tooling" },
  design:  { emoji: "🎨", description: "UI/UX, branding, graphics, motion" },
  content: { emoji: "✍️",  description: "Writing, translation, documentation, research" },
  data:    { emoji: "📊", description: "Data analysis, labeling, scraping, ML datasets" },
  other:   { emoji: "🔧", description: "Everything else" },
};

export default function CategoryPage() {
  const { cat } = useParams<{ cat: string }>();
  const [page, setPage] = useState(0);

  if (!CATEGORIES.includes(cat as typeof CATEGORIES[number])) {
    notFound();
  }

  const catMeta = CATEGORY_META[cat]!;
  const offset = BigInt(page) * PAGE_SIZE;

  const { jobIds, isLoading } = useOpenBounties(cat, offset, PAGE_SIZE);

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-6">
        <Link href="/" className="hover:text-white transition-colors">All Bounties</Link>
        <span>/</span>
        <span className="text-white capitalize">{cat}</span>
      </div>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold">
          {catMeta.emoji} <span className="capitalize">{cat}</span>
        </h1>
        <p className="text-gray-400 mt-1">{catMeta.description}</p>
      </div>

      {/* Category nav */}
      <div className="flex flex-wrap gap-2 mb-6">
        {CATEGORIES.map(c => (
          <Link
            key={c}
            href={`/category/${c}`}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors border capitalize
              ${c === cat
                ? "bg-white text-gray-900 border-white"
                : "border-gray-700 text-gray-400 hover:border-gray-500"
              }`}
          >
            {CATEGORY_META[c]!.emoji} {c}
          </Link>
        ))}
      </div>

      {/* Bounty list */}
      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : !jobIds || jobIds.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <div className="text-4xl mb-3">{catMeta.emoji}</div>
          <p className="mb-4">No open bounties in this category.</p>
          <Link href="/post" className="text-blue-400 hover:text-blue-300 text-sm underline">
            Post the first one →
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {jobIds.map(jobId => (
            <CategoryBountyLoader key={jobId.toString()} jobId={jobId} />
          ))}
        </div>
      )}

      {/* Pagination */}
      <div className="flex gap-3 mt-8 justify-center">
        {page > 0 && (
          <button
            onClick={() => setPage(p => p - 1)}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm"
          >
            ← Prev
          </button>
        )}
        {jobIds && jobIds.length === Number(PAGE_SIZE) && (
          <button
            onClick={() => setPage(p => p + 1)}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm"
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}

function CategoryBountyLoader({ jobId }: { jobId: bigint }) {
  const { data: meta } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getBountyMeta",
    args: [jobId],
    query: { refetchInterval: 8_000 },
  });

  if (!meta) return <div className="h-24 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />;
  return <BountyCard meta={meta as BountyMeta} />;
}
