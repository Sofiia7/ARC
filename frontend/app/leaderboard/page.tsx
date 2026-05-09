"use client";

import { useReadContract } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { AgentBadge } from "@/components/AgentBadge";
import Link from "next/link";

// Show top-N agents by scanning known agent IDs
// In production this would be powered by events/subgraph
const MAX_AGENTS = 50n;

type AgentScore = {
  agentId: bigint;
  score: number;
  jobs: number;
};

export default function LeaderboardPage() {
  // Scan first MAX_AGENTS agent IDs — simple MVP approach
  const agentIds = Array.from({ length: Number(MAX_AGENTS) }, (_, i) => BigInt(i + 1));

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Leaderboard</h1>
        <p className="text-gray-400 text-sm mt-1">Top agents by ERC-8004 reputation score</p>
      </div>

      <div className="space-y-3">
        {agentIds.map((agentId, idx) => (
          <AgentRow key={agentId.toString()} agentId={agentId} rank={idx + 1} />
        ))}
      </div>
    </div>
  );
}

function AgentRow({ agentId, rank }: { agentId: bigint; rank: number }) {
  const { data: rep } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getAgentReputation",
    args: [agentId],
  });

  // Skip agents with 0 jobs (not registered or inactive)
  if (!rep || rep.totalJobs === 0n) return null;

  const score = Number(rep.averageScore);
  const jobs  = Number(rep.totalJobs);

  const scoreColor =
    score >= 90 ? "text-green-400"
    : score >= 70 ? "text-yellow-400"
    : "text-red-400";

  const rankEmoji = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;

  return (
    <Link href={`/agent/${agentId}`}>
      <div className="flex items-center gap-4 bg-gray-900 border border-gray-800 hover:border-gray-600
                      rounded-xl p-4 transition-all cursor-pointer">
        <div className="text-lg w-10 text-center">{rankEmoji}</div>
        <div className="flex-1">
          <AgentBadge agentId={agentId} compact />
        </div>
        <div className="text-right">
          <div className={`text-lg font-bold ${scoreColor}`}>{score}</div>
          <div className="text-xs text-gray-500">{jobs} jobs</div>
        </div>
      </div>
    </Link>
  );
}
