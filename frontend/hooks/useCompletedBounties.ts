"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, BOUNTY_ADAPTER_DEPLOY_BLOCK } from "@/lib/contracts";
import { getLogsChunked } from "@/lib/chainLogs";

export type CompletedRecord = {
  jobId:           bigint;
  agentId:         bigint;          // 0 = human worker
  reputationScore: bigint;
  blockNumber:     bigint;
  reward:          bigint;          // gross reward (6-decimal USDC), from BountyCreated
};

const BOUNTY_COMPLETED = BOUNTY_ADAPTER_ABI.find(
  e => e.type === "event" && e.name === "BountyCompleted",
)!;
const BOUNTY_CREATED = BOUNTY_ADAPTER_ABI.find(
  e => e.type === "event" && e.name === "BountyCreated",
)!;

/**
 * Pulls every BountyCompleted + BountyCreated event ever emitted by the
 * adapter and returns structured, reward-joined records. Backed by
 * react-query with a 60s TTL; data is fresh enough for leaderboard rankings
 * without a server-side indexer.
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
      // Chunked scans anchored at the deploy block — the Arc RPC rejects
      // full-range eth_getLogs outright (HTTP 413). See lib/chainLogs.ts.
      const completedLogs = await getLogsChunked(
        publicClient,
        { address: CONTRACTS.BOUNTY_ADAPTER, event: BOUNTY_COMPLETED as never },
        BOUNTY_ADAPTER_DEPLOY_BLOCK,
      );
      const createdLogs = await getLogsChunked(
        publicClient,
        { address: CONTRACTS.BOUNTY_ADAPTER, event: BOUNTY_CREATED as never },
        BOUNTY_ADAPTER_DEPLOY_BLOCK,
      );

      const rewardByJobId = new Map<string, bigint>();
      for (const l of createdLogs as Array<{ args: unknown }>) {
        const a = l.args as { jobId: bigint; reward: bigint };
        rewardByJobId.set(a.jobId.toString(), a.reward);
      }

      return (completedLogs as Array<{ args: unknown; blockNumber?: bigint }>).map(l => {
        const a = l.args as { jobId: bigint; agentId: bigint; reputationScore: bigint };
        return {
          jobId:           a.jobId,
          agentId:         a.agentId,
          reputationScore: a.reputationScore,
          blockNumber:     l.blockNumber ?? 0n,
          // Gross reward posted for this job. Falls back to 0n for the rare
          // case a BountyCreated log wasn't found (shouldn't happen — every
          // completed job was necessarily created first).
          reward:          rewardByJobId.get(a.jobId.toString()) ?? 0n,
        };
      });
    },
  });
}

export type AgentStats = {
  agentId:        bigint;
  jobsDone:       number;
  avgScore:       number;
  lastJobAt:      bigint; // block number
  /**
   * V4_DESIGN_ANTI_SYBIL.md Proposal B2 — a sqrt(reward)-weighted average of
   * reputationScore across this agent's completions. sqrt (not linear)
   * dampens one whale bounty from dominating the score, while still weighting
   * a $50 job more than a $1 one. Shown alongside, not instead of, the raw
   * ERC-8004 averageScore — that one is Arc's registry value and can be
   * inflated by self-dealing at the $1 minimum; this one can't be, as cheaply.
   */
  weightedScore:  number;
  totalVolumeUsdc: number;
};

/** Aggregate per-agent stats from completion events. Excludes human (agentId=0). */
export function aggregateAgentStats(records: CompletedRecord[]): AgentStats[] {
  const byAgent = new Map<
    string,
    { sum: bigint; count: number; lastBlock: bigint; weightedSum: number; weightTotal: number; volume: bigint }
  >();
  for (const r of records) {
    if (r.agentId === 0n) continue;
    const key = r.agentId.toString();
    const cur = byAgent.get(key)
      ?? { sum: 0n, count: 0, lastBlock: 0n, weightedSum: 0, weightTotal: 0, volume: 0n };
    cur.sum += r.reputationScore;
    cur.count += 1;
    cur.volume += r.reward;
    const rewardUsdc = Number(r.reward) / 1e6;
    const weight = Math.sqrt(Math.max(rewardUsdc, 0));
    cur.weightedSum += Number(r.reputationScore) * weight;
    cur.weightTotal += weight;
    if (r.blockNumber > cur.lastBlock) cur.lastBlock = r.blockNumber;
    byAgent.set(key, cur);
  }
  const out: AgentStats[] = [];
  for (const [key, v] of byAgent) {
    out.push({
      agentId:         BigInt(key),
      jobsDone:        v.count,
      avgScore:        v.count === 0 ? 0 : Number(v.sum) / v.count,
      lastJobAt:       v.lastBlock,
      weightedScore:   v.weightTotal === 0 ? 0 : v.weightedSum / v.weightTotal,
      totalVolumeUsdc: Number(v.volume) / 1e6,
    });
  }
  // Default order: jobsDone desc, then avgScore desc.
  out.sort((a, b) => b.jobsDone - a.jobsDone || b.avgScore - a.avgScore);
  return out;
}
