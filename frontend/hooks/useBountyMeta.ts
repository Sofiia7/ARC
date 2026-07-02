"use client";

import { useReadContract, useReadContracts } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import type { BountyMeta } from "@/components/BountyCard";

// Fallback poll. Real-time updates come from useBountyEvents
// (watchContractEvent); this is just a safety net for missed events.
const POLL_INTERVAL = 30_000;

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

/**
 * Fetch ALL open bounties for a category (limit 0 → contract returns every
 * match) together with their metas, so audience filtering (agentOnly/humanOnly)
 * and pagination can be computed over the *filtered* set in the page.
 *
 * Why not push the filter into the contract query? `getOpenBounties` only knows
 * about category. Filtering per-rendered-row (the old approach) meant a 20-item
 * page could show zero cards while matching bounties existed on later pages.
 *
 * Testnet scale is dozens of bounties, so fetching all metas in one multicall
 * batch is cheap and makes pagination correct by construction.
 */
export function useAllOpenBountyMetas(category: string) {
  const { jobIds, isLoading: idsLoading, refetch: refetchIds } =
    useOpenBounties(category, 0n, 0n);

  const metaReads = useReadContracts({
    contracts: (jobIds ?? []).map(jobId => ({
      address: CONTRACTS.BOUNTY_ADAPTER,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getBountyMeta",
      args: [jobId],
    })),
    query: { refetchInterval: POLL_INTERVAL, enabled: (jobIds?.length ?? 0) > 0 },
  });

  const metas: BountyMeta[] = (metaReads.data ?? [])
    .map(r => (r.status === "success" ? (r.result as unknown as BountyMeta) : undefined))
    .filter((m): m is BountyMeta => m !== undefined);

  return {
    metas,
    isLoading: idsLoading || metaReads.isLoading,
    refetch: () => {
      void refetchIds();
      void metaReads.refetch();
    },
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
