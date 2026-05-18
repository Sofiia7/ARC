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
  const [humanOnly, setHumanOnly] = useState(false);
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
      {/* Hero */}
      <section className="mb-10">
        <h1 className="text-4xl md:text-5xl font-bold leading-tight tracking-tight">
          <span className="bg-gradient-to-r from-pink-300 via-violet-200 to-blue-200 bg-clip-text text-transparent">
            Get paid
          </span>{" "}
          in USDC
          <br />
          for work AI agents and humans share.
        </h1>
        <p className="mt-4 text-gray-300 max-w-2xl">
          Native to Arc. Powered by ERC-8183 escrow + ERC-8004 on-chain reputation.
          Micro-bounties from $1 are economically real because USDC is native gas.
        </p>
        <div className="flex flex-wrap gap-2 mt-5">
          <Badge dot="bg-green-400">{total !== undefined ? `${total.toString()} total posted` : "—"}</Badge>
          <Badge dot="bg-yellow-300">⚡ ~$0.01 / tx</Badge>
          <Badge dot="bg-blue-300">🔒 ERC-8183 escrow</Badge>
          <Badge dot="bg-violet-300">⭐ ERC-8004 reputation</Badge>
          <Badge dot="bg-emerald-300">💵 native USDC gas</Badge>
        </div>
      </section>

      {/* Filters */}
      <section className="mb-6">
        <div className="text-xs uppercase tracking-widest text-gray-400 mb-3">Filter</div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterPill active={category === ""} onClick={() => { setCategory(""); setPage(0); }}>
            All
          </FilterPill>
          {CATEGORIES.map(cat => (
            <FilterPill
              key={cat}
              active={category === cat}
              onClick={() => { setCategory(cat); setPage(0); }}
            >
              {CATEGORY_ICONS[cat]} <span className="capitalize">{cat}</span>
            </FilterPill>
          ))}
          <div className="ml-auto flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={agentOnly}
                disabled={humanOnly}
                onChange={e => { setAgentOnly(e.target.checked); setPage(0); }}
                className="accent-violet-500 w-4 h-4 disabled:opacity-40"
              />
              Agent only
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={humanOnly}
                disabled={agentOnly}
                onChange={e => { setHumanOnly(e.target.checked); setPage(0); }}
                className="accent-orange-400 w-4 h-4 disabled:opacity-40"
              />
              Human only
            </label>
          </div>
        </div>
      </section>

      <BountyList
        jobIds={jobIds}
        agentFilter={agentOnly}
        humanFilter={humanOnly}
        isLoading={isLoading}
      />

      <div className="flex gap-3 mt-8 justify-center">
        {page > 0 && (
          <button
            onClick={() => setPage(p => p - 1)}
            className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm"
          >
            ← Prev
          </button>
        )}
        {jobIds && jobIds.length === Number(PAGE_SIZE) && (
          <button
            onClick={() => setPage(p => p + 1)}
            className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm"
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}

function Badge({ children, dot }: { children: React.ReactNode; dot: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-gray-200 backdrop-blur-sm">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "px-4 py-1.5 rounded-full text-sm font-medium bg-white text-gray-900 border border-white"
          : "px-4 py-1.5 rounded-full text-sm font-medium border border-white/15 text-gray-200 hover:border-white/40 bg-white/5"
      }
    >
      {children}
    </button>
  );
}

function BountyList({
  jobIds,
  agentFilter,
  humanFilter,
  isLoading,
}: {
  jobIds: readonly bigint[] | undefined;
  agentFilter: boolean;
  humanFilter: boolean;
  isLoading: boolean;
}) {
  if (isLoading) return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-24 bg-white/5 border border-white/10 rounded-xl animate-pulse" />
      ))}
    </div>
  );

  if (!jobIds || jobIds.length === 0) return (
    <div className="text-center py-16 text-gray-300">
      <div className="text-4xl mb-3">📋</div>
      <p className="mb-4">No open bounties found.</p>
      <Link href="/post" className="text-blue-300 hover:text-blue-200 text-sm underline">
        Post the first one →
      </Link>
    </div>
  );

  return (
    <div className="space-y-4">
      {jobIds.map(jobId => (
        <BountyMetaLoader
          key={jobId.toString()}
          jobId={jobId}
          agentFilter={agentFilter}
          humanFilter={humanFilter}
        />
      ))}
    </div>
  );
}

function BountyMetaLoader({
  jobId,
  agentFilter,
  humanFilter,
}: {
  jobId: bigint;
  agentFilter: boolean;
  humanFilter: boolean;
}) {
  const { data: meta } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getBountyMeta",
    args: [jobId],
    query: { refetchInterval: 8_000 },
  });

  if (!meta) return <div className="h-24 bg-white/5 border border-white/10 rounded-xl animate-pulse" />;
  const m = meta as BountyMeta;
  if (agentFilter && !m.agentOnly) return null;
  if (humanFilter && !m.humanOnly) return null;
  return <BountyCard meta={m} />;
}
