"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";

export type CompletedRecord = {
  jobId:           bigint;
  agentId:         bigint;          // 0 = human worker
  reputationScore: bigint;
  blockNumber:     bigint;
};

const BOUNTY_COMPLETED = BOUNTY_ADAPTER_ABI.find(
  e => e.type === "event" && e.name === "BountyCompleted",
)!;

/**
 * Pulls every BountyCompleted event ever emitted by the adapter and returns
 * structured records. Backed by react-query with a 60s TTL; data is fresh
 * enough for leaderboard rankings without a server-side indexer.
 *
 * For large histories (>10k events) this gets expensive. We'll swap in a real
 * indexer in Sprint 4 — until then, the testnet history fits comfortably.
 */
export function useCompletedBounties() {
  const publicClient = usePublicClient();

  return useQuery<CompletedRecord[]>({
    queryKey: ["completed-bounties", CONTRACTS.BOUNTY_ADAPTER],
    enabled: !!publicClient,
    staleTime: 60_000,
    queryFn: async () => {
      if (!publicClient) return [];
      const logs = await publicClient.getLogs({
        address: CONTRACTS.BOUNTY_ADAPTER,
        event: BOUNTY_COMPLETED as never,
        fromBlock: 0n,
        toBlock: "latest",
      });
      return (logs as Array<{ args: unknown; blockNumber?: bigint }>).map(l => {
        const a = l.args as { jobId: bigint; agentId: bigint; reputationScore: bigint };
        return {
          jobId:           a.jobId,
          agentId:         a.agentId,
          reputationScore: a.reputationScore,
          blockNumber:     l.blockNumber ?? 0n,
        };
      });
    },
  });
}

export type AgentStats = {
  agentId:    bigint;
  jobsDone:   number;
  avgScore:   number;
  lastJobAt:  bigint; // block number
};

/** Aggregate per-agent stats from completion events. Excludes human (agentId=0). */
export function aggregateAgentStats(records: CompletedRecord[]): AgentStats[] {
  const byAgent = new Map<string, { sum: bigint; count: number; lastBlock: bigint }>();
  for (const r of records) {
    if (r.agentId === 0n) continue;
    const key = r.agentId.toString();
    const cur = byAgent.get(key) ?? { sum: 0n, count: 0, lastBlock: 0n };
    cur.sum += r.reputationScore;
    cur.count += 1;
    if (r.blockNumber > cur.lastBlock) cur.lastBlock = r.blockNumber;
    byAgent.set(key, cur);
  }
  const out: AgentStats[] = [];
  for (const [key, v] of byAgent) {
    out.push({
      agentId:   BigInt(key),
      jobsDone:  v.count,
      avgScore:  v.count === 0 ? 0 : Number(v.sum) / v.count,
      lastJobAt: v.lastBlock,
    });
  }
  // Default order: jobsDone desc, then avgScore desc.
  out.sort((a, b) => b.jobsDone - a.jobsDone || b.avgScore - a.avgScore);
  return out;
}
