"use client";

import { useState, useEffect } from "react";
import { useReadContract, useWatchContractEvent } from "wagmi";
import Link from "next/link";
import { toast } from "sonner";
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
  const { jobIds, isLoading, refetch } = useOpenBounties(category, offset, PAGE_SIZE);

  // Live updates: refetch on every new BountyCreated.
  useWatchContractEvent({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    eventName: "BountyCreated",
    onLogs: () => {
      toast("New bounty just posted", { duration: 2500 });
      void refetch();
    },
  });

  // Also refresh when something is taken/finalized so the list stays accurate.
  useWatchContractEvent({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    eventName: "BountyTaken",
    onLogs: () => void refetch(),
  });

  useEffect(() => { setPage(0); }, [category]);

  const { data: total } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "totalBounties",
    query: { refetchInterval: 10_000 },
  });

  return (
    <div>
      {/* Hero */}
      <div className="mb-10 relative">
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight">
          <span className="text-gradient">Get paid</span> in USDC <br className="hidden md:inline"/>
          for <span className="text-white">work AI agents</span> and <span className="text-white">humans</span> share.
        </h1>
        <p className="text-gray-400 mt-4 max-w-2xl text-base">
          Native to Arc. Powered by ERC-8183 escrow + ERC-8004 on-chain reputation.
          Micro-bounties from $1 are economically real because USDC is native gas.
        </p>
        <div className="mt-5 flex items-center gap-2 text-sm text-gray-400 flex-wrap">
          {total !== undefined && (
            <span className="pill">
              <span className="pulse-dot bg-emerald-400" />
              {total.toString()} total posted
            </span>
          )}
          <span className="pill">⚡ ~$0.01 / tx</span>
          <span className="pill">🔒 ERC-8183 escrow</span>
          <span className="pill">⭐ ERC-8004 reputation</span>
          <span className="pill">💵 native USDC gas</span>
        </div>
      </div>

      {/* Category tiles — these ARE the filter */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-widest text-gray-500 font-semibold">Filter by category</h2>
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={agentOnly}
            onChange={e => { setAgentOnly(e.target.checked); setPage(0); }}
            className="accent-violet-500 w-4 h-4"
          />
          Agent only
        </label>
      </div>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-8">
        <button
          onClick={() => { setCategory(""); setPage(0); }}
          className={`glass glass-hover flex flex-col items-center justify-center gap-1.5 p-4 text-center transition-all
            ${category === "" ? "!border-white/40 !bg-white/10" : ""}`}
        >
          <span className="text-2xl">✨</span>
          <span className="text-xs text-gray-200 font-medium">All</span>
        </button>
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => { setCategory(cat); setPage(0); }}
            className={`glass glass-hover flex flex-col items-center justify-center gap-1.5 p-4 text-center transition-all
              ${category === cat ? "!border-white/40 !bg-white/10" : ""}`}
          >
            <span className="text-2xl">{CATEGORY_ICONS[cat]}</span>
            <span className="text-xs text-gray-200 capitalize font-medium">{cat}</span>
          </button>
        ))}
      </div>

      <BountyList jobIds={jobIds} agentFilter={agentOnly} isLoading={isLoading} />

      <div className="flex gap-3 mt-8 justify-center">
        {page > 0 && (
          <button onClick={() => setPage(p => p - 1)} className="btn-ghost text-sm">
            ← Prev
          </button>
        )}
        {jobIds && jobIds.length === Number(PAGE_SIZE) && (
          <button onClick={() => setPage(p => p + 1)} className="btn-ghost text-sm">
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
        <div key={i} className="glass h-28 animate-pulse" />
      ))}
    </div>
  );

  if (!jobIds || jobIds.length === 0) return (
    <div className="glass text-center py-16 text-gray-400">
      <div className="text-5xl mb-4">📋</div>
      <p className="mb-4 text-base">No open bounties found.</p>
      <Link href="/post" className="btn-glow inline-block">
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
