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

const CATEGORY_META: Record<string, { icon: string; description: string }> = {
  dev:     { icon: "⌘", description: "Smart contracts, frontend, backend, tooling" },
  design:  { icon: "◐", description: "UI/UX, branding, graphics, motion" },
  content: { icon: "✎", description: "Writing, translation, documentation, research" },
  data:    { icon: "▤", description: "Data analysis, labeling, scraping, ML datasets" },
  other:   { icon: "◯", description: "Everything else" },
};

export default function CategoryPage() {
  const { cat } = useParams<{ cat: string }>();
  const [page, setPage] = useState(0);

  if (!CATEGORIES.includes(cat as typeof CATEGORIES[number])) {
    notFound();
  }

  const catMeta = CATEGORY_META[cat]!;
  const offset  = BigInt(page) * PAGE_SIZE;
  const { jobIds, isLoading } = useOpenBounties(cat, offset, PAGE_SIZE);

  return (
    <>
      {/* Breadcrumb */}
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Browse</Link>
        <span className="sep">/</span>
        <span className="current" style={{ textTransform: "capitalize", fontFamily: "inherit", fontSize: 13 }}>
          {cat}
        </span>
      </nav>

      <header className="page-head">
        <h1>
          <span style={{ marginRight: 12, fontWeight: 600 }}>{catMeta.icon}</span>
          <span style={{ textTransform: "capitalize" }}>{cat}</span>
        </h1>
        <p className="sub">{catMeta.description}</p>
      </header>

      {/* Category nav as small glass pills */}
      <div className="cats" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        {CATEGORIES.map(c => (
          <Link
            key={c}
            href={`/category/${c}`}
            style={{ textDecoration: "none", color: "inherit" }}
          >
            <button type="button" className={`cat${c === cat ? " active" : ""}`}>
              <span className="ico">{CATEGORY_META[c]!.icon}</span>
              <span className="name" style={{ textTransform: "capitalize" }}>{c}</span>
            </button>
          </Link>
        ))}
      </div>

      {/* Bounty list */}
      {isLoading ? (
        <div className="list" style={{ marginTop: 24 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="row" style={{ height: 92, opacity: 0.5 }} />
          ))}
        </div>
      ) : !jobIds || jobIds.length === 0 ? (
        <div style={{ textAlign: "center", padding: "64px 0", color: "var(--ink-soft)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>{catMeta.icon}</div>
          <p style={{ marginBottom: 16 }}>No open bounties in this category.</p>
          <Link href="/post" style={{ color: "var(--honey)", textDecoration: "underline", fontSize: 14 }}>
            Post the first one →
          </Link>
        </div>
      ) : (
        <div className="list">
          {jobIds.map(jobId => (
            <CategoryBountyLoader key={jobId.toString()} jobId={jobId} />
          ))}
        </div>
      )}

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

function CategoryBountyLoader({ jobId }: { jobId: bigint }) {
  const { data: meta } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getBountyMeta",
    args: [jobId],
    query: { refetchInterval: 8_000 },
  });

  if (!meta) return <div className="row" style={{ height: 92, opacity: 0.5 }} />;
  return <BountyCard meta={meta as BountyMeta} />;
}
