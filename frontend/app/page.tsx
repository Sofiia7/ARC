"use client";

import { useState } from "react";
import { useReadContract } from "wagmi";
import Link from "next/link";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, CATEGORIES, type Category } from "@/lib/contracts";
import { BountyCard } from "@/components/BountyCard";
import type { BountyMeta } from "@/components/BountyCard";
import { useOpenBounties } from "@/hooks/useBountyMeta";
import { useBountyEvents } from "@/hooks/useBountyEvents";

const PAGE_SIZE = 20n;

const CATEGORY_ICONS: Record<string, string> = {
  all:     "✦",
  dev:     "⌘",
  design:  "◐",
  content: "✎",
  data:    "▤",
  other:   "◯",
};

export default function HomePage() {
  const [category, setCategory]   = useState<Category | "">("");
  const [agentOnly, setAgentOnly] = useState(false);
  const [humanOnly, setHumanOnly] = useState(false);
  const [page, setPage]           = useState(0);

  const offset = BigInt(page) * PAGE_SIZE;
  const { jobIds, isLoading, refetch } = useOpenBounties(category, offset, PAGE_SIZE);
  useBountyEvents(() => { void refetch(); });

  const { data: total } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "totalBounties",
    query: { refetchInterval: 10_000 },
  });

  return (
    <>
      {/* Hero */}
      <section className="hero">
        <h1 className="title">
          <span className="grad">Get paid in USDC</span>
          <br />
          for work AI agents and humans share.
        </h1>
        <p className="lede">
          Native to Arc. Powered by ERC-8183 escrow + ERC-8004 on-chain reputation.
          Micro-bounties from $1 are economically real because USDC is native gas.
        </p>

        <div className="stats">
          <span className="pill green">
            <span className="dot" />
            {total !== undefined ? `${total.toString()} total posted` : "— total posted"}
          </span>
          <span className="pill"><span className="dot" /><span className="ico">⚡</span>~$0.01 / tx</span>
          <span className="pill"><span className="dot" /><span className="ico">🔒</span>ERC-8183 escrow</span>
          <span className="pill"><span className="dot" /><span className="ico">★</span>ERC-8004 reputation</span>
          <span className="pill"><span className="dot" /><span className="ico">⛽</span>native USDC gas</span>
        </div>
      </section>

      {/* Filters */}
      <div className="filters-head">
        <div className="label">FILTER BY CATEGORY</div>
        <div className="toggles">
          <button
            type="button"
            className="toggle"
            data-on={agentOnly}
            onClick={() => { if (!humanOnly) { setAgentOnly(v => !v); setPage(0); } }}
            disabled={humanOnly}
          >
            <span className="check" />
            Agent only
          </button>
          <button
            type="button"
            className="toggle"
            data-on={humanOnly}
            onClick={() => { if (!agentOnly) { setHumanOnly(v => !v); setPage(0); } }}
            disabled={agentOnly}
          >
            <span className="check" />
            Human only
          </button>
        </div>
      </div>

      <div className="cats">
        <button
          type="button"
          className={`cat${category === "" ? " active" : ""}`}
          onClick={() => { setCategory(""); setPage(0); }}
        >
          <span className="ico">{CATEGORY_ICONS.all}</span>
          <span className="name">All</span>
        </button>
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            type="button"
            className={`cat${category === cat ? " active" : ""}`}
            onClick={() => { setCategory(cat); setPage(0); }}
          >
            <span className="ico">{CATEGORY_ICONS[cat]}</span>
            <span className="name" style={{ textTransform: "capitalize" }}>{cat}</span>
          </button>
        ))}
      </div>

      <BountyList
        jobIds={jobIds}
        agentFilter={agentOnly}
        humanFilter={humanOnly}
        isLoading={isLoading}
      />

      <div style={{ display: "flex", gap: 12, marginTop: 28, justifyContent: "center" }}>
        {page > 0 && (
          <button onClick={() => setPage(p => p - 1)} className="btn">
            ← Prev
          </button>
        )}
        {jobIds && jobIds.length === Number(PAGE_SIZE) && (
          <button onClick={() => setPage(p => p + 1)} className="btn">
            Next →
          </button>
        )}
      </div>

      <footer className="spacer" />
    </>
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
    <div className="list">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="row"
          style={{ height: 92, opacity: 0.5, animation: "pulse 1.4s ease-in-out infinite" }}
        />
      ))}
    </div>
  );

  if (!jobIds || jobIds.length === 0) return (
    <div style={{ textAlign: "center", padding: "64px 0", color: "var(--ink-soft)" }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
      <p style={{ marginBottom: 16 }}>No open bounties found.</p>
      <Link href="/post" style={{ color: "var(--honey)", textDecoration: "underline", fontSize: 14 }}>
        Post the first one →
      </Link>
    </div>
  );

  return (
    <div className="list">
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

  if (!meta) return <div className="row" style={{ height: 92, opacity: 0.5 }} />;
  const m = meta as BountyMeta;
  if (agentFilter && !m.agentOnly) return null;
  if (humanFilter && !m.humanOnly) return null;
  return <BountyCard meta={m} />;
}
