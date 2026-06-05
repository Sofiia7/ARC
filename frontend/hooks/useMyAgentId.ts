"use client";

import { useEffect, useState, useCallback } from "react";
import { useChainId, usePublicClient } from "wagmi";
import { CONTRACTS, IDENTITY_REGISTRY_ABI } from "@/lib/contracts";

const ZERO = "0x0000000000000000000000000000000000000000";

function cacheKey(chainId: number, address: string): string {
  return `arcbounty:agentIds:${chainId}:${address.toLowerCase()}`;
}

function readCache(chainId: number | undefined, address: string | undefined): bigint[] {
  if (!address || chainId === undefined || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(cacheKey(chainId, address));
    if (!raw) return [];
    return (JSON.parse(raw) as string[]).map(s => BigInt(s));
  } catch {
    return [];
  }
}

function writeCache(chainId: number, address: string, ids: bigint[]) {
  if (typeof window === "undefined") return;
  try {
    const key = cacheKey(chainId, address);
    if (ids.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(ids.map(b => b.toString())));
  } catch {
    // ignore
  }
}

/**
 * Append a freshly-minted agentId into the SAME cache this hook reads, so the
 * Navbar badge updates instantly after registration without waiting for an RPC
 * re-scan. Must be called with the chainId the registration happened on.
 *
 * (Previously the register page wrote a different, singular key —
 * `arcbounty:agentId:<addr>` — which this hook never read, so the badge only
 * updated after a full getLogs scan, which could silently fail on RPC limits.)
 */
export function appendAgentIdToCache(chainId: number, address: string, id: bigint): void {
  const existing = readCache(chainId, address);
  if (existing.some(x => x === id)) return;
  writeCache(chainId, address, [...existing, id]);
}

// Bounded historical scan: a `fromBlock: 0n` getLogs is rejected by public RPCs
// on long chains. Look back a fixed window (mirrors the SDK's lookback).
const LOOKBACK_BLOCKS = 500_000n;

/**
 * Returns every ERC-8004 agent currently owned by `address` on the active chain.
 *
 *  • `agentIds` — full list (most-recent last). `undefined` while loading.
 *  • `agentId`  — primary (most-recent mint). Kept for the existing single-agent UI.
 *  • `refresh()` — force re-scan.
 *
 * Cache is keyed by chainId AND address, so switching networks doesn't show
 * stale data from another chain.
 */
export function useMyAgentId(address: string | undefined): {
  agentId: bigint | null | undefined;
  agentIds: bigint[] | undefined;
  refresh: () => Promise<void>;
} {
  const publicClient = usePublicClient();
  const chainId      = useChainId();
  const [agentIds, setAgentIds] = useState<bigint[] | undefined>(() => readCache(chainId, address));

  const refresh = useCallback(async () => {
    if (!address || !publicClient) return;
    try {
      const head = await publicClient.getBlockNumber();
      const fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
      const logs = await publicClient.getLogs({
        address: CONTRACTS.IDENTITY_REGISTRY,
        event: IDENTITY_REGISTRY_ABI.find(x => x.type === "event")!,
        args: { from: ZERO, to: address as `0x${string}` },
        fromBlock,
      });
      const ids = logs.map(l => (l.args as { tokenId: bigint }).tokenId);
      setAgentIds(ids);
      writeCache(chainId, address, ids);
    } catch {
      // leave previous value
    }
  }, [address, publicClient, chainId]);

  useEffect(() => {
    if (!address) {
      setAgentIds([]);
      return;
    }
    setAgentIds(readCache(chainId, address));
    void refresh();
  }, [address, chainId, refresh]);

  const agentId: bigint | null | undefined =
    agentIds === undefined ? undefined :
    agentIds.length === 0  ? null      :
    agentIds[agentIds.length - 1]!;

  return { agentId, agentIds, refresh };
}
