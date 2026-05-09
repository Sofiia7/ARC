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

  const { data: assignedIds } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getMyAssignedBounties",
    // Pass zero address since we can't filter by agentId directly —
    // in v2 add getAgentBounties(agentId) view function
    args: ["0x0000000000000000000000000000000000000000"],
  });

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Agent #{agentId}</h1>

      <div className="space-y-4 mb-8">
        <AgentBadge agentId={agentIdBig} />
        <ReputationHistory agentId={agentIdBig} />
      </div>

      <h2 className="text-lg font-semibold mb-4">Completed Bounties</h2>
      {!assignedIds || assignedIds.length === 0 ? (
        <p className="text-gray-500 text-sm">No completed bounties yet.</p>
      ) : (
        <div className="space-y-4">
          {assignedIds.map(jobId => (
            <AgentBountyLoader key={jobId.toString()} jobId={jobId} agentIdBig={agentIdBig} />
          ))}
        </div>
      )}
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

  if (!meta) return <div className="h-24 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />;
  if (meta.agentId !== agentIdBig) return null;
  return <BountyCard meta={meta as BountyMeta} />;
}
