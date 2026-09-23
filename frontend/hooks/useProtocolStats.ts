"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { fetchAllBountyMetas, isPaidToWorker, workerOf } from "@/lib/bountyMetas";

// Public, on-chain-verifiable protocol stats for /stats. It is the public
// dashboard linked from grant reports, so every number has to be right, not
// just usually right: they are computed from the adapter's own storage (see
// lib/bountyMetas.ts), which is also what makes them match the board. They
// used to be counted from event logs, and a failed log scan showed "1 posted,
// 0 completed" while 13 bounties existed.

export type ProtocolStats = {
  totalPosted: number;
  usdcPostedGross: bigint;   // sum of rewards across all created bounties
  completed: number;
  completedByAgents: number;
  usdcPaidGross: bigint;     // sum of rewards of completed bounties (pre-fee)
  protocolFeesUsdc: bigint;  // feeBps of each completed reward
  uniquePosters: number;
  uniqueWorkers: number;
  uniqueAgents: number;      // distinct agentIds that took at least one bounty
  openNow: number | null;
};

export function useProtocolStats() {
  const publicClient = usePublicClient();

  return useQuery<ProtocolStats>({
    queryKey: ["protocol-stats", CONTRACTS.BOUNTY_ADAPTER],
    enabled: !!publicClient,
    staleTime: 60_000,
    queryFn: async () => {
      if (!publicClient) throw new Error("no public client");

      const [metas, feeBps] = await Promise.all([
        fetchAllBountyMetas(publicClient),
        publicClient.readContract({
          address: CONTRACTS.BOUNTY_ADAPTER, abi: BOUNTY_ADAPTER_ABI, functionName: "feeBps",
        }) as Promise<bigint>,
      ]);
      const now = BigInt(Math.floor(Date.now() / 1000));

      const posters = new Set<string>();
      const workers = new Set<string>();
      const agents = new Set<string>();
      let usdcPostedGross = 0n;
      let usdcPaidGross = 0n;
      let completed = 0;
      let completedByAgents = 0;
      let openNow = 0;
      for (const m of metas) {
        posters.add(m.poster.toLowerCase());
        usdcPostedGross += m.reward;
        const worker = workerOf(m);
        if (worker) workers.add(worker);
        if (m.agentId > 0n) agents.add(m.agentId.toString());
        if (!m.resolved && !m.isTaken && m.deadline > now) openNow++;
        if (isPaidToWorker(m)) {
          completed++;
          if (m.agentId > 0n) completedByAgents++;
          usdcPaidGross += m.reward;
        }
      }

      return {
        totalPosted: metas.length,
        usdcPostedGross,
        completed,
        completedByAgents,
        usdcPaidGross,
        protocolFeesUsdc: (usdcPaidGross * feeBps) / 10_000n,
        uniquePosters: posters.size,
        uniqueWorkers: workers.size,
        uniqueAgents: agents.size,
        openNow,
      };
    },
  });
}
