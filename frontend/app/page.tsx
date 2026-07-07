"use client";

import { useMemo, useState } from "react";
import { useReadContract } from "wagmi";
import Link from "next/link";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, CATEGORIES, type Category } from "@/lib/contracts";
import { BountyCard } from "@/components/BountyCard";
import type { BountyMeta } from "@/components/BountyCard";
import { useAllOpenBountyMetas } from "@/hooks/useBountyMeta";
import { useBountyEvents } from "@/hooks/useBountyEvents";

const PAGE_SIZE = 20;

type SortBy = "newest" | "reward-desc" | "deadline-soon";

function compareBigint(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

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
  const [search, setSearch]       = useState("");
  const [sortBy, setSortBy]       = useState<SortBy>("newest");
  const [page, setPage]           = useState(0);

  const { metas, isLoading, refetch } = useAllOpenBountyMetas(category);
  useBountyEvents(() => { void refetch(); });

  // Filter by audience + search over the full set, THEN paginate — so a
  // filtered view never shows a falsely-empty page while matches exist
  // further down. Search matches category + tags (ТЗ §12.4) — the
  // description itself lives on IPFS and isn't fetched for the list view.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return metas.filter(m => {
      if (agentOnly && !m.agentOnly) return false;
      if (humanOnly && !m.humanOnly) return false;
      if (q) {
        const haystack = [m.category, ...m.tags].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [metas, agentOnly, humanOnly, search]);

  const sorted = useMemo(() => {
    if (sortBy === "newest") return filtered;
    const arr = [...filtered];
    if (sortBy === "reward-desc") arr.sort((a, b) => compareBigint(b.reward, a.reward));
    else arr.sort((a, b) => compareBigint(a.deadline, b.deadline)); // deadline-soon
    return arr;
  }, [filtered, sortBy]);

  const pageItems = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const hasNext = (page + 1) * PAGE_SIZE < sorted.length;

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

      {/* Search + sort */}
      <div className="filters-head" style={{ gap: 14 }}>
        <input
          type="search"
          className="input"
          placeholder="Search by category or tag…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0); }}
          style={{ maxWidth: 280 }}
          aria-label="Search bounties by category or tag"
        />
        <div className="seg" style={{ marginLeft: "auto" }}>
          <button
            type="button"
            className={sortBy === "newest" ? "active" : undefined}
            onClick={() => { setSortBy("newest"); setPage(0); }}
          >
            Newest
          </button>
          <button
            type="button"
            className={sortBy === "reward-desc" ? "active" : undefined}
            onClick={() => { setSortBy("reward-desc"); setPage(0); }}
          >
            Reward ↓
          </button>
          <button
            type="button"
            className={sortBy === "deadline-soon" ? "active" : undefined}
            onClick={() => { setSortBy("deadline-soon"); setPage(0); }}
          >
            Deadline soon
          </button>
        </div>
      </div>

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

      <BountyList items={pageItems} isLoading={isLoading} />

      <div style={{ display: "flex", gap: 12, marginTop: 28, justifyContent: "center" }}>
        {page > 0 && (
          <button onClick={() => setPage(p => p - 1)} className="btn">
            ← Prev
          </button>
        )}
        {hasNext && (
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
  items,
  isLoading,
}: {
  items: BountyMeta[];
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

  if (items.length === 0) return (
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
      {items.map(m => (
        <BountyCard key={m.jobId.toString()} meta={m} />
      ))}
    </div>
  );
}
