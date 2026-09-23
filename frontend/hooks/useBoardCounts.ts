"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { CONTRACTS } from "@/lib/contracts";
import { fetchAllBountyMetas, isPaidToWorker } from "@/lib/bountyMetas";

export type BoardCounts = { posted: number; completed: number };

/**
 * Posted and completed counts for the home page, from the same storage read
 * and the same "paid" rule as /stats, so the two can never disagree. The
 * caller wires `refetch` into its useBountyEvents subscription, which is what
 * makes a new bounty or payout show within one event poll; the interval here
 * is only the safety net. Not subscribing here keeps the page at one poller.
 */
export function useBoardCounts() {
  const publicClient = usePublicClient();
  return useQuery<BoardCounts>({
    queryKey: ["board-counts", CONTRACTS.BOUNTY_ADAPTER],
    enabled: !!publicClient,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!publicClient) throw new Error("no public client");
      const metas = await fetchAllBountyMetas(publicClient);
      return { posted: metas.length, completed: metas.filter(isPaidToWorker).length };
    },
  });
}
