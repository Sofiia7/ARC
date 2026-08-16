"use client";

import { useEffect, useRef } from "react";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";

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

  // Keep the latest callback in a ref so an inline `() => refetch()` passed by
  // callers does NOT re-run the effect (and re-create all 13 subscriptions) on
  // every render. The effect only re-subscribes when the client/adapter/jobId
  // actually change.
  const cb = useRef(onEvent);
  useEffect(() => {
    cb.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!publicClient) return;

    // ONE subscription for all 13 events, not one per event.
    //
    // Every watcher is an independent poller issuing its own eth_getLogs, so
    // the per-event version cost 13 requests every 4s — measured at ~17 rps
    // from a single tab against Base's public RPC, which then throttles
    // everything else the page does. The symptom is not an error: the board's
    // own reads silently never settle and it renders "No open bounties found"
    // while the contract has open bounties. Omitting `eventName` watches every
    // event in the ABI in one poll, and since all 13 handlers did the same
    // thing — call `onEvent` — nothing is lost.
    const unwatch = publicClient.watchContractEvent({
      address: adapter,
      abi: BOUNTY_ADAPTER_ABI,
      // Server-side arg filtering needs a single event; with the merged watch
      // the jobId check moves into onLogs (see below).
      onLogs: logs => {
        if (jobId === undefined) {
          cb.current();
          return;
        }
        const match = logs.some(log => {
          const args = (log as { args?: { jobId?: bigint } }).args;
          return args?.jobId === jobId;
        });
        if (match) cb.current();
      },
      // 12s instead of 4s: this is a refresh nudge for data that also polls on
      // its own, not a trading feed. Three times fewer requests for latency
      // nobody notices.
      pollingInterval: 12_000,
    });
    return () => unwatch();
  }, [publicClient, adapter, jobId]);
}
