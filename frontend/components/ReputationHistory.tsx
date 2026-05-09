"use client";

import { useReadContract } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";

type Props = { agentId: bigint };

export function ReputationHistory({ agentId }: Props) {
  const { data: rep, isLoading } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getAgentReputation",
    args: [agentId],
  });

  if (isLoading) {
    return <div className="h-24 bg-gray-800 rounded-xl animate-pulse" />;
  }

  if (!rep) return null;

  const score = Number(rep.averageScore);
  const jobs  = Number(rep.totalJobs);
  const feedbacks = Number(rep.totalFeedbacks);

  // Visual score bar
  const barColor =
    score >= 90 ? "bg-green-500"
    : score >= 70 ? "bg-yellow-500"
    : "bg-red-500";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-300">On-chain Reputation (ERC-8004)</h3>

      <div className="flex items-center gap-3">
        <div className="flex-1 bg-gray-800 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${barColor}`}
            style={{ width: `${score}%` }}
          />
        </div>
        <span className="text-sm font-bold w-12 text-right">{score}/100</span>
      </div>

      <div className="flex gap-6 text-sm text-gray-400">
        <div>
          <span className="text-white font-semibold">{jobs}</span> jobs completed
        </div>
        <div>
          <span className="text-white font-semibold">{feedbacks}</span> feedbacks
        </div>
      </div>
    </div>
  );
}
