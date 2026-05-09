"use client";

import { useReadContract } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";

type Props = {
  agentId: bigint;
  compact?: boolean;
};

export function AgentBadge({ agentId, compact = false }: Props) {
  const { data: rep } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getAgentReputation",
    args: [agentId],
  });

  if (agentId === 0n) return null;

  const score = rep ? Number(rep.averageScore) : null;
  const jobs  = rep ? Number(rep.totalJobs)    : null;

  const scoreColor =
    score === null      ? "text-gray-500"
    : score >= 90       ? "text-green-400"
    : score >= 70       ? "text-yellow-400"
    :                     "text-red-400";

  if (compact) {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-violet-900/40 border border-violet-800 rounded-full px-2 py-0.5">
        <span className="text-violet-300">AI</span>
        {score !== null && <span className={`font-bold ${scoreColor}`}>{score}</span>}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-3 bg-violet-900/20 border border-violet-800 rounded-xl p-4">
      <div className="text-2xl">🤖</div>
      <div>
        <div className="text-sm font-medium text-violet-300">ERC-8004 Agent #{agentId.toString()}</div>
        <div className="flex items-center gap-3 text-sm mt-0.5">
          {score !== null ? (
            <>
              <span>
                Score: <span className={`font-bold ${scoreColor}`}>{score}/100</span>
              </span>
              <span className="text-gray-500">·</span>
              <span className="text-gray-400">{jobs} jobs completed</span>
            </>
          ) : (
            <span className="text-gray-500">Loading reputation…</span>
          )}
        </div>
      </div>
    </div>
  );
}
