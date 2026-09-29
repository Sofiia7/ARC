"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { HISTORY_ADAPTERS } from "@/lib/bountyMetas";
import { aggregateWorkerStats, useCompletedBounties, type CompletedRecord, type WorkerStats } from "./useCompletedBounties";

export type AgentReputation = { averageScore: number; totalFeedbacks: number; totalJobs: number };

const ADAPTERS: readonly Address[] = [CONTRACTS.BOUNTY_ADAPTER, ...HISTORY_ADAPTERS];

/**
 * ERC-8004 reputation as the adapters report it, over the current adapter and
 * the network's earlier ones, averaged by each adapter's feedback count. Base
 * agent #83995 earned its record on V4.6; read from V4.7 alone its profile
 * said 0/100 and 0 jobs while the leaderboard showed 2 (BaseBounty #8's bug
 * report, 2026-09-28).
 */
export function useAgentReputations(agentIds: readonly bigint[]) {
  const ids = agentIds.filter(id => id > 0n);
  const key = ids.join(",");
  const reads = useReadContracts({
    contracts: ids.flatMap(agentId => ADAPTERS.map(address => ({
      address,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getAgentReputation" as const,
      args: [agentId] as const,
    }))),
    query: { enabled: ids.length > 0, staleTime: 60_000 },
  });
  const byAgent = useMemo(() => {
    const m = new Map<string, AgentReputation>();
    ids.forEach((agentId, i) => {
      let weighted = 0;
      let feedbacks = 0;
      let jobs = 0;
      let seen = false;
      ADAPTERS.forEach((_, j) => {
        const r = reads.data?.[i * ADAPTERS.length + j];
        if (r?.status !== "success") return;
        const v = r.result as { averageScore: bigint; totalFeedbacks: bigint; totalJobs: bigint };
        seen = true;
        weighted += Number(v.averageScore) * Number(v.totalFeedbacks);
        feedbacks += Number(v.totalFeedbacks);
        jobs += Number(v.totalJobs);
      });
      if (seen) {
        m.set(agentId.toString(), {
          averageScore: feedbacks > 0 ? Math.round(weighted / feedbacks) : 0,
          totalFeedbacks: feedbacks,
          totalJobs: jobs,
        });
      }
    });
    return m;
    // `key` stands for `ids`, which is a fresh array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reads.data]);
  return { byAgent, isLoading: reads.isLoading, isError: reads.isError };
}

/**
 * One agent's completed work, counted exactly as the leaderboard counts it:
 * the wallets that ever worked under this agent id, and every paid bounty of
 * those wallets, on the current adapter and the earlier ones. So "jobs
 * completed" and "unique posters" on the profile match its leaderboard row.
 */
export function useAgentWork(agentId: bigint, { enabled = true }: { enabled?: boolean } = {}) {
  const { data: records, isLoading } = useCompletedBounties({ enabled: enabled && agentId > 0n });
  return useMemo(() => {
    if (!records) return { row: undefined as WorkerStats | undefined, records: [] as CompletedRecord[], isLoading };
    const wallets = new Set(records.filter(r => r.agentId === agentId).map(r => r.worker));
    const mine = records.filter(r => r.agentId === agentId || wallets.has(r.worker));
    const row = aggregateWorkerStats(mine).find(w => w.agentId === agentId);
    return { row, records: mine, isLoading };
  }, [records, agentId, isLoading]);
}
