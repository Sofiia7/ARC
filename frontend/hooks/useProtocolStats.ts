"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { fetchAllBountyMetas } from "@/lib/bountyMetas";
import { computeProtocolStats, type ProtocolStats } from "@/lib/protocolStats";

// Public, on-chain-verifiable protocol stats for /stats. It is the public
// dashboard linked from grant reports, so every number has to be right, not
// just usually right: they are computed from the adapter's own storage (see
// lib/bountyMetas.ts), which is also what makes them match the board. They
// used to be counted from event logs, and a failed log scan showed "1 posted,
// 0 completed" while 13 bounties existed. The arithmetic lives in
// lib/protocolStats.ts, shared with the public API's /api/v1/stats.

export type { ProtocolStats };

export function useProtocolStats() {
  const publicClient = usePublicClient();

  return useQuery<ProtocolStats>({
    queryKey: ["protocol-stats", CONTRACTS.BOUNTY_ADAPTER, "with-history"],
    enabled: !!publicClient,
    staleTime: 60_000,
    queryFn: async () => {
      if (!publicClient) throw new Error("no public client");

      const [metas, feeBps] = await Promise.all([
        fetchAllBountyMetas(publicClient, { withHistory: true }),
        publicClient.readContract({
          address: CONTRACTS.BOUNTY_ADAPTER, abi: BOUNTY_ADAPTER_ABI, functionName: "feeBps",
        }) as Promise<bigint>,
      ]);
      return computeProtocolStats(metas, feeBps, BigInt(Math.floor(Date.now() / 1000)));
    },
  });
}
