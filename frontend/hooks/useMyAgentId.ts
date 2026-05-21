"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { CONTRACTS, IDENTITY_REGISTRY_ABI } from "@/lib/contracts";

const ZERO = "0x0000000000000000000000000000000000000000";

function cacheKey(address: string): string {
  return `arcbounty:agentId:${address.toLowerCase()}`;
}

function readCache(address: string | undefined): bigint | null {
  if (!address || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(address));
    if (!raw) return null;
    return BigInt(raw);
  } catch {
    return null;
  }
}

function writeCache(address: string, agentId: bigint | null) {
  if (typeof window === "undefined") return;
  try {
    if (agentId === null) {
      window.localStorage.removeItem(cacheKey(address));
    } else {
      window.localStorage.setItem(cacheKey(address), agentId.toString());
    }
  } catch {
    // ignore
  }
}

/**
 * Returns the most recently-minted ERC-8004 agent owned by `address`.
 *
 * Strategy:
 *  1. Read localStorage cache for an instant value on revisit.
 *  2. In the background, scan Transfer events on IdentityRegistry where
 *     to=address from genesis (testnet — small block range) and update
 *     the cache.
 *
 * Returns `null` for "no agent registered" and `undefined` while the
 * first lookup is in flight.
 */
export function useMyAgentId(address: string | undefined): {
  agentId: bigint | null | undefined;
  refresh: () => Promise<void>;
} {
  const publicClient = usePublicClient();
  const [agentId, setAgentId] = useState<bigint | null | undefined>(() => readCache(address));

  async function refresh() {
    if (!address || !publicClient) return;
    try {
      const logs = await publicClient.getLogs({
        address: CONTRACTS.IDENTITY_REGISTRY,
        event: IDENTITY_REGISTRY_ABI.find(x => x.type === "event")!,
        args: { from: ZERO, to: address as `0x${string}` },
        fromBlock: 0n,
      });
      if (logs.length === 0) {
        setAgentId(null);
        writeCache(address, null);
        return;
      }
      const last = logs[logs.length - 1]!;
      const tokenId = (last.args as { tokenId: bigint }).tokenId;
      setAgentId(tokenId);
      writeCache(address, tokenId);
    } catch {
      // leave previous value
    }
  }

  useEffect(() => {
    if (!address) {
      setAgentId(null);
      return;
    }
    // Show cached value immediately, refresh in background.
    setAgentId(readCache(address));
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, publicClient]);

  return { agentId, refresh };
}
