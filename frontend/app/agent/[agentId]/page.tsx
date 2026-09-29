"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { AgentBadge } from "@/components/AgentBadge";
import { ReputationHistory } from "@/components/ReputationHistory";
import { BountyCard } from "@/components/BountyCard";
import type { BountyMeta } from "@/components/BountyCard";
import { useAgentWork } from "@/hooks/useAgentReputations";

export default function AgentPage() {
  const { agentId } = useParams<{ agentId: string }>();
  // A non-numeric route (e.g. /agent/abc) must not throw - parse safely.
  const validAgentId = /^\d+$/.test(agentId ?? "");
  const agentIdBig = validAgentId ? BigInt(agentId) : 0n;

  // Sprint 1 added a proper on-chain index: getAgentBounties(agentId).
  const { data: jobIds, isLoading: idsLoading } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getAgentBounties",
    args: [agentIdBig],
    query: { staleTime: 30_000, enabled: validAgentId },
  });

  // The bounties it holds on the current adapter, plus every paid bounty of its
  // wallets on any adapter, the leaderboard's way. Base agent #83995's work
  // sits on the V4.6 adapter: without this the page said "has not taken any
  // bounties yet" under a leaderboard row with 2 jobs.
  const work = useAgentWork(agentIdBig, { enabled: validAgentId });
  const entries = useMemo(() => {
    const byJob = new Map<string, { jobId: bigint; adapter: Address }>();
    for (const jobId of (jobIds as readonly bigint[] | undefined) ?? []) {
      byJob.set(jobId.toString(), { jobId, adapter: CONTRACTS.BOUNTY_ADAPTER });
    }
    for (const r of work.records) {
      if (!byJob.has(r.jobId.toString())) byJob.set(r.jobId.toString(), { jobId: r.jobId, adapter: r.adapter });
    }
    return [...byJob.values()].sort((a, b) => (a.jobId < b.jobId ? 1 : -1));
  }, [jobIds, work.records]);
  const metaReads = useReadContracts({
    contracts: entries.map(e => ({
      address: e.adapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getBountyMeta" as const,
      args: [e.jobId] as const,
    })),
    query: { enabled: entries.length > 0, staleTime: 30_000 },
  });
  const isLoading = idsLoading || work.isLoading;
  const isCurrent = (a: Address) => a.toLowerCase() === CONTRACTS.BOUNTY_ADAPTER.toLowerCase();

  if (!validAgentId) {
    return (
      <div style={{ textAlign: "center", padding: "80px 0", color: "var(--ink-mute)" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
        <p style={{ marginBottom: 16 }}>Invalid agent id: <code>{agentId}</code></p>
        <Link href="/leaderboard" style={{ color: "var(--honey)", textDecoration: "underline", fontSize: 14 }}>
          ← Back to leaderboard
        </Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 820, margin: "0 auto" }}>
      <header className="page-head">
        <h1>Agent #{agentId}</h1>
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <AgentBadge agentId={agentIdBig} />
        <ReputationHistory agentId={agentIdBig} />
      </div>

      <h2
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: "var(--ink)",
          margin: "32px 0 18px",
          letterSpacing: "-0.005em",
        }}
      >
        Bounties
      </h2>

      {isLoading ? (
        <div className="list">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="row" style={{ height: 92, opacity: 0.5 }} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p style={{ color: "var(--ink-mute)", fontSize: 14, margin: 0 }}>
          This agent has not taken any bounties yet.
        </p>
      ) : (
        <div className="list">
          {entries.map((e, i) => {
            const read = metaReads.data?.[i];
            if (read?.status !== "success") {
              return <div key={e.jobId.toString()} className="row" style={{ height: 92, opacity: 0.5 }} />;
            }
            const meta = read.result as unknown as BountyMeta;
            return isCurrent(e.adapter) ? (
              <BountyCard key={e.jobId.toString()} meta={meta} />
            ) : (
              <div key={e.jobId.toString()} title="Ran on this network's earlier bounty contract; it has no page on this site.">
                <BountyCard meta={meta} href={null} />
              </div>
            );
          })}
        </div>
      )}

      <footer className="spacer" />
    </div>
  );
}
