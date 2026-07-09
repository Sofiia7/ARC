"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId, usePublicClient, useReadContract } from "wagmi";
import type { AbiEvent } from "viem";
import { toast } from "sonner";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, BOUNTY_ADAPTER_DEPLOY_BLOCK } from "@/lib/contracts";
import { getLogsChunked } from "@/lib/chainLogs";
import { useBountyEvents } from "@/hooks/useBountyEvents";

export type ActivityItem = {
  id: string;          // `${jobId}:${eventName}:${blockNumber}` — stable across scans
  jobId: string;
  eventName: string;
  blockNumber: number;
  read: boolean;
};

// Excludes BountyCreated (that's just "you posted it") — everything else is
// something happening to a bounty you posted or took, which is exactly what
// a poster/provider can't currently see without opening every row.
const EVENT_NAMES = [
  "BountyTaken", "WorkSubmitted", "BountyCompleted", "BountyAutoApproved",
  "BountyCancelled", "BountyExpired", "RejectionProposed", "RejectionFinalized",
  "RejectionChallenged", "DisputeRaised", "DisputeResponded", "DisputeResolved",
  "ArbitratorTimeoutClaimed",
] as const;

export const ACTIVITY_LABELS: Record<string, string> = {
  BountyTaken: "Someone took your bounty",
  WorkSubmitted: "Work was submitted",
  BountyCompleted: "Bounty approved & paid",
  BountyAutoApproved: "Auto-approved & paid",
  BountyCancelled: "Bounty cancelled",
  BountyExpired: "Bounty expired",
  RejectionProposed: "Submission was rejected",
  RejectionFinalized: "Rejection finalized",
  RejectionChallenged: "Rejection was challenged",
  DisputeRaised: "Dispute opened",
  DisputeResponded: "Dispute response submitted",
  DisputeResolved: "Dispute resolved",
  ArbitratorTimeoutClaimed: "Arbitrator timeout claimed",
};

function storageKey(chainId: number, address: string): string {
  return `arcbounty:activity:${chainId}:${address.toLowerCase()}`;
}

function readStored(chainId: number, address: string): ActivityItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(chainId, address));
    return raw ? (JSON.parse(raw) as ActivityItem[]) : [];
  } catch {
    return [];
  }
}

function writeStored(chainId: number, address: string, items: ActivityItem[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(chainId, address), JSON.stringify(items.slice(0, 50)));
  } catch {
    // ignore — activity history is a convenience, not source of truth
  }
}

/**
 * Full-history activity feed for bounties the connected wallet posted or
 * took. Backed by Blockscout (via getLogsChunked), not a live subscription,
 * so it also catches events that happened while the wallet was disconnected
 * — a plain watchContractEvent only sees things from the moment it mounts.
 *
 * "Read" state persists per-address in localStorage; a fresh live event
 * (caught via useBountyEvents while the tab is open) also fires a toast.
 */
export function useMyActivity() {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();

  const { data: postedIds } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getMyPostedBounties",
    args: [address!],
    query: { enabled: !!address },
  });
  const { data: assignedIds } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getMyAssignedBounties",
    args: [address!],
    query: { enabled: !!address },
  });

  const myJobIds = useMemo(() => {
    const s = new Set<string>();
    (postedIds ?? []).forEach(id => s.add(id.toString()));
    (assignedIds ?? []).forEach(id => s.add(id.toString()));
    return s;
  }, [postedIds, assignedIds]);
  const myJobIdsKey = useMemo(() => [...myJobIds].sort().join(","), [myJobIds]);

  const [items, setItems] = useState<ActivityItem[]>([]);
  const itemsRef = useRef<ActivityItem[]>([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const scan = useCallback(async (announceNew: boolean) => {
    if (!address || !publicClient || myJobIds.size === 0) {
      setItems([]);
      return;
    }
    const stored = readStored(chainId, address);
    const readIds = new Set(stored.filter(i => i.read).map(i => i.id));

    const abiEvents = BOUNTY_ADAPTER_ABI.filter(
      x => x.type === "event" && (EVENT_NAMES as readonly string[]).includes(x.name),
    ) as unknown as AbiEvent[];

    const results = await Promise.all(abiEvents.map(async ev => {
      try {
        const logs = await getLogsChunked(
          publicClient,
          { address: CONTRACTS.BOUNTY_ADAPTER, event: ev },
          BOUNTY_ADAPTER_DEPLOY_BLOCK,
        );
        return logs
          .filter(l => myJobIds.has(String((l.args as { jobId: bigint }).jobId)))
          .map((l): ActivityItem => {
            const jobId = String((l.args as { jobId: bigint }).jobId);
            const blockNumber = Number(l.blockNumber ?? 0n);
            const id = `${jobId}:${ev.name}:${blockNumber}`;
            return { id, jobId, eventName: ev.name!, blockNumber, read: readIds.has(id) };
          });
      } catch {
        return [];
      }
    }));

    const merged = results.flat().sort((a, b) => b.blockNumber - a.blockNumber).slice(0, 50);

    // Only toast for items that are new since the LAST scan this session —
    // never on the very first (cold-load backfill would spam every past event).
    if (announceNew && itemsRef.current.length > 0) {
      const priorIds = new Set(itemsRef.current.map(i => i.id));
      for (const item of merged) {
        if (!priorIds.has(item.id)) {
          toast.info(`Bounty #${item.jobId}: ${ACTIVITY_LABELS[item.eventName] ?? item.eventName}`);
        }
      }
    }

    setItems(merged);
    writeStored(chainId, address, merged);
  }, [address, chainId, publicClient, myJobIds]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- myJobIdsKey is the intentional dep, not myJobIds/scan (new refs each render)
  useEffect(() => { void scan(false); }, [address, chainId, myJobIdsKey]);

  useBountyEvents(useCallback(() => { void scan(true); }, [scan]));

  const unreadCount = items.filter(i => !i.read).length;

  const markAllRead = useCallback(() => {
    if (!address) return;
    setItems(prev => {
      if (prev.every(i => i.read)) return prev;
      const next = prev.map(i => ({ ...i, read: true }));
      writeStored(chainId, address, next);
      return next;
    });
  }, [address, chainId]);

  return { items, unreadCount, markAllRead };
}
