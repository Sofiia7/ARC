"use client";

import { useReadContract } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import type { BountyMeta } from "@/components/BountyCard";

const POLL_INTERVAL = 8_000; // 8 seconds

export function useBountyMeta(jobId: bigint) {
  const result = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getBountyMeta",
    args: [jobId],
    query: {
      refetchInterval: POLL_INTERVAL,
    },
  });

  return {
    meta: result.data as BountyMeta | undefined,
    isLoading: result.isLoading,
    refetch: result.refetch,
  };
}

export function useOpenBounties(category: string, offset: bigint, limit: bigint) {
  const result = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getOpenBounties",
    args: [category, offset, limit],
    query: {
      refetchInterval: POLL_INTERVAL,
    },
  });

  return {
    jobIds: result.data as readonly bigint[] | undefined,
    isLoading: result.isLoading,
    refetch: result.refetch,
  };
}
