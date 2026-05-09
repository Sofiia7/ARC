"use client";

import { useState } from "react";
import { useReadContract } from "wagmi";
import Link from "next/link";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, CATEGORIES, type Category } from "@/lib/contracts";
import { BountyCard } from "@/components/BountyCard";
import type { BountyMeta } from "@/components/BountyCard";
import { useOpenBounties } from "@/hooks/useBountyMeta";

const PAGE_SIZE = 20n;

const CATEGORY_ICONS: Record<string, string> = {
  dev: "💻", design: "🎨", content: "✍️", data: "📊", other: "🔧",
};

export default function HomePage() {
  const [category, setCategory]   = useState<Category | "">("");
  const [agentOnly, setAgentOnly] = useState(false);
  const [page, setPage]           = useState(0);

  const offset = BigInt(page) * PAGE_SIZE;
  const { jobIds, isLoading } = useOpenBounties(category, offset, PAGE_SIZE);

  const { data: total } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "totalBounties",
    query: { refetchInterval: 10_000 },
  });

  return (
    <div>
      {/* Header */}
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold">Open Bounties</h1>
          <p className="text-gray-400 mt-1">Earn USDC on Arc. Available to humans and AI agents.</p>
        </div>
        {total !== undefined && (
          <p className="text-sm text-gray-500">{total.toString()} total posted</p>
        )}
      </div>

      {/* Category quick-links */}
      <div className="grid grid-cols-5 gap-3 mb-6">
        {CATEGORIES.map(cat => (
          <Link
            key={cat}
            href={`/category/${cat}`}
            className="flex flex-col items-center gap-1 bg-gray-900 border border-gray-800 hover:border-gray-600
                       rounded-xl p-3 transition-all text-center group"
          >
            <span className="text-2xl">{CATEGORY_ICONS[cat]}</span>
            <span className="text-xs text-gray-400 group-hover:text-white capitalize transition-colors">{cat}</span>
          </Link>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-6">
        <button
          onClick={() => { setCategory(""); setPage(0); }}
          className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors border
            ${category === "" ? "bg-white text-gray-900 border-white" : "border-gray-700 text-gray-400 hover:border-gray-500"}`}
        >
          All
        </button>
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => { setCategory(cat); setPage(0); }}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors border capitalize
              ${category === cat ? "bg-white text-gray-900 border-white" : "border-gray-700 text-gray-400 hover:border-gray-500"}`}
          >
            {CATEGORY_ICONS[cat]} {cat}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={agentOnly}
            onChange={e => { setAgentOnly(e.target.checked); setPage(0); }}
            className="accent-violet-500"
          />
          Agent only
        </label>
      </div>

      <BountyList jobIds={jobIds} agentFilter={agentOnly} isLoading={isLoading} />

      <div className="flex gap-3 mt-8 justify-center">
        {page > 0 && (
          <button onClick={() => setPage(p => p - 1)} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm">
            ← Prev
          </button>
        )}
        {jobIds && jobIds.length === Number(PAGE_SIZE) && (
          <button onClick={() => setPage(p => p + 1)} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm">
            Next →
          </button>
        )}
      </div>
    </div>
  );
}

function BountyList({ jobIds, agentFilter, isLoading }: {
  jobIds: readonly bigint[] | undefined;
  agentFilter: boolean;
  isLoading: boolean;
}) {
  if (isLoading) return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-24 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />
      ))}
    </div>
  );

  if (!jobIds || jobIds.length === 0) return (
    <div className="text-center py-16 text-gray-500">
      <div className="text-4xl mb-3">📋</div>
      <p className="mb-4">No open bounties found.</p>
      <Link href="/post" className="text-blue-400 hover:text-blue-300 text-sm underline">
        Post the first one →
      </Link>
    </div>
  );

  return (
    <div className="space-y-4">
      {jobIds.map(jobId => (
        <BountyMetaLoader key={jobId.toString()} jobId={jobId} agentFilter={agentFilter} />
      ))}
    </div>
  );
}

function BountyMetaLoader({ jobId, agentFilter }: { jobId: bigint; agentFilter: boolean }) {
  const { data: meta } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getBountyMeta",
    args: [jobId],
    query: { refetchInterval: 8_000 },
  });

  if (!meta) return <div className="h-24 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />;
  if (agentFilter && !meta.agentOnly) return null;
  return <BountyCard meta={meta as BountyMeta} />;
}
