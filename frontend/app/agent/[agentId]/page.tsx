"use client";

import { useParams } from "next/navigation";
import { useReadContract } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { AgentBadge } from "@/components/AgentBadge";
import { ReputationHistory } from "@/components/ReputationHistory";
import { BountyCard } from "@/components/BountyCard";
import type { BountyMeta } from "@/components/BountyCard";

export default function AgentPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const agentIdBig = BigInt(agentId);

  // Sprint 1 added a proper on-chain index: getAgentBounties(agentId).
  const { data: jobIds, isLoading } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getAgentBounties",
    args: [agentIdBig],
    query: { staleTime: 30_000 },
  });

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
      ) : !jobIds || jobIds.length === 0 ? (
        <p style={{ color: "var(--ink-mute)", fontSize: 14, margin: 0 }}>
          This agent has not taken any bounties yet.
        </p>
      ) : (
        <div className="list">
          {jobIds.map(jobId => (
            <AgentBountyLoader key={jobId.toString()} jobId={jobId} />
          ))}
        </div>
      )}

      <footer className="spacer" />
    </div>
  );
}

function AgentBountyLoader({ jobId }: { jobId: bigint }) {
  const { data: meta } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getBountyMeta",
    args: [jobId],
  });

  if (!meta) return <div className="row" style={{ height: 92, opacity: 0.5 }} />;
  return <BountyCard meta={meta as BountyMeta} />;
}
