"use client";

import { useEffect } from "react";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";

const EVENTS = [
  "BountyCreated",
  "BountyTaken",
  "WorkSubmitted",
  "BountyCompleted",
  "BountyAutoApproved",
  "BountyCancelled",
  "BountyExpired",
  "RejectionProposed",
  "RejectionFinalized",
  "RejectionChallenged",
  "DisputeRaised",
  "DisputeResponded",
  "DisputeResolved",
] as const;

/**
 * Subscribe to BountyAdapter events and invoke `onEvent` on any match.
 *
 * If `jobId` is provided, only events whose `jobId` topic matches fire — the
 * detail page uses this to live-refresh a single bounty. The home page omits
 * it and reacts to anything.
 *
 * Returns no value: callers pass their `refetch` (from useReadContract) and
 * forget about it. Cleanup is automatic on unmount / address change.
 */
export function useBountyEvents(onEvent: () => void, jobId?: bigint): void {
  const publicClient = usePublicClient();
  const adapter: Address = CONTRACTS.BOUNTY_ADAPTER;

  useEffect(() => {
    if (!publicClient) return;
    const unwatches = EVENTS.map(eventName =>
      publicClient.watchContractEvent({
        address: adapter,
        abi: BOUNTY_ADAPTER_ABI,
        eventName,
        args: jobId !== undefined ? ({ jobId } as never) : undefined,
        onLogs: () => onEvent(),
        // Sane default poll — viem batches multiple events per call.
        pollingInterval: 4_000,
      }),
    );
    return () => unwatches.forEach(u => u());
  }, [publicClient, adapter, jobId, onEvent]);
}
