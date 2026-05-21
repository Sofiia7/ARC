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

  // No on-chain `getAgentBounties(agentId)` view yet — scan via assigned bounties of
  // the zero address (returns empty) as a placeholder; in v2 add a proper view.
  const { data: assignedIds } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getMyAssignedBounties",
    args: ["0x0000000000000000000000000000000000000000"],
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
        Completed Bounties
      </h2>

      {!assignedIds || assignedIds.length === 0 ? (
        <p style={{ color: "var(--ink-mute)", fontSize: 14, margin: 0 }}>
          No completed bounties yet.
        </p>
      ) : (
        <div className="list">
          {assignedIds.map(jobId => (
            <AgentBountyLoader key={jobId.toString()} jobId={jobId} agentIdBig={agentIdBig} />
          ))}
        </div>
      )}

      <footer className="spacer" />
    </div>
  );
}

function AgentBountyLoader({ jobId, agentIdBig }: { jobId: bigint; agentIdBig: bigint }) {
  const { data: meta } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getBountyMeta",
    args: [jobId],
  });

  if (!meta) return <div className="row" style={{ height: 92, opacity: 0.5 }} />;
  if (meta.agentId !== agentIdBig) return null;
  return <BountyCard meta={meta as BountyMeta} />;
}
