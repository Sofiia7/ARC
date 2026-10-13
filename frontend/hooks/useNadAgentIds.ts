"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { parseAbi, type PublicClient } from "viem";
import { CONTRACTS } from "@/lib/contracts";
import { getActiveNetwork } from "@/lib/networks";
import { batchRead } from "@/lib/nadReads";
import {
  agentCacheKey,
  controlledAgents,
  legacyAgentCacheKey,
  mergeAgentIds,
  missingOwnedCount,
  parseAgentIdInput,
  parseAgentIdList,
  serializeAgentIds,
  type AgentControl,
} from "@/lib/nadAgents";

const registryAbi = parseAbi([
  "function ownerOf(uint256) view returns(address)",
  "function getAgentWallet(uint256) view returns(address)",
  "function balanceOf(address) view returns(uint256)",
]);
/** Ids per multicall while scanning the registry, and a hard stop so a scan can never run away. */
const SCAN_CHUNK = 400;
const SCAN_LIMIT = 100_000;

function readStored(key: string): bigint[] {
  try {
    return parseAgentIdList(window.localStorage.getItem(key));
  } catch {
    return [];
  }
}
function writeStored(key: string, ids: readonly bigint[]) {
  try {
    if (ids.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, serializeAgentIds(ids));
  } catch {
    // private mode or blocked storage: the list is rebuilt from the chain next time
  }
}

async function checkAgents(client: PublicClient, ids: readonly bigint[]): Promise<AgentControl[]> {
  if (ids.length === 0) return [];
  const calls = ids.flatMap((id) => [
    { address: CONTRACTS.IDENTITY_REGISTRY, abi: registryAbi, functionName: "ownerOf", args: [id] },
    { address: CONTRACTS.IDENTITY_REGISTRY, abi: registryAbi, functionName: "getAgentWallet", args: [id] },
  ]);
  const results = await batchRead(client, calls);
  return ids.map((id, i) => {
    const owner = results[2 * i];
    const wallet = results[2 * i + 1];
    return {
      id,
      owner: owner.ok ? String(owner.value) : null,
      wallet: wallet.ok ? String(wallet.value) : null,
    };
  });
}

export type AddAgentResult = { ok: true; id: bigint } | { ok: false; error: string };
export type NadAgentIds = {
  /** Agents the connected wallet can act for on Monad (identity owner or registered working wallet), ascending. */
  ids: bigint[];
  /** "loading" until the first verification has finished. */
  status: "idle" | "loading" | "ready" | "error";
  /** balanceOf(wallet) on the identity registry: how many agents it owns outright. */
  owned: number | undefined;
  /** Owned agents not listed yet (the registry cannot be enumerated). */
  missing: number;
  scanning: boolean;
  /** How many registry ids the last scan has covered. */
  scanned: number;
  /** Adds an agent id typed by the user after checking the wallet controls it. */
  addManual: (raw: string) => Promise<AddAgentResult>;
  /** Walks the registry by ownerOf (a few requests per 400 ids) until every owned agent is found. */
  scan: () => Promise<void>;
  isMine: (agentId: bigint) => boolean;
};

/**
 * The ERC-8004 agent ids the connected wallet can act for on Monad.
 *
 * The Monad identity registry is not enumerable (no tokenOfOwnerByIndex or totalSupply, checked 2026-10-13) and the RPC
 * caps eth_getLogs at 100 blocks, so there is no way to ask "which agents does this wallet have". Instead the hook
 * verifies candidates with ownerOf and getAgentWallet (the same two checks the adapter makes): ids remembered in
 * localStorage for this wallet (this site's cache and the key hooks/useMyAgentId writes), `candidates` (pass the agents
 * on the bounty's own entries), and ids typed in by the user. balanceOf tells how many owned agents are still missing,
 * and scan() can find them by walking the registry.
 */
export function useNadAgentIds(candidates: readonly bigint[] = []): NadAgentIds {
  const { address } = useAccount();
  const client = usePublicClient();
  const chainId = getActiveNetwork().chainId;
  const [ids, setIds] = useState<bigint[]>([]);
  const [ownedIds, setOwnedIds] = useState<bigint[]>([]);
  const [owned, setOwned] = useState<number>();
  const [status, setStatus] = useState<NadAgentIds["status"]>("idle");
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(0);
  const candidateKey = useMemo(() => mergeAgentIds(candidates).join(","), [candidates]);

  useEffect(() => {
    let live = true;
    if (!address || !client) {
      setIds([]);
      setOwnedIds([]);
      setOwned(undefined);
      setStatus("idle");
      return;
    }
    setStatus("loading");
    const list = mergeAgentIds(
      readStored(agentCacheKey(chainId, address)),
      readStored(legacyAgentCacheKey(chainId, address)),
      candidateKey ? candidateKey.split(",").map((id) => BigInt(id)) : [],
    );
    void (async () => {
      try {
        const [checks, balance] = await Promise.all([
          checkAgents(client as PublicClient, list),
          batchRead(client as PublicClient, [
            { address: CONTRACTS.IDENTITY_REGISTRY, abi: registryAbi, functionName: "balanceOf", args: [address] },
          ]),
        ]);
        if (!live) return;
        const mine = controlledAgents(checks, address);
        setIds(mine.map((m) => m.id));
        setOwnedIds(mine.filter((m) => m.isOwner).map((m) => m.id));
        setOwned(balance[0].ok ? Number(balance[0].value) : undefined);
        setStatus("ready");
        writeStored(
          agentCacheKey(chainId, address),
          mine.map((m) => m.id),
        );
      } catch {
        if (live) setStatus("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [address, client, chainId, candidateKey]);

  const remember = useCallback(
    (found: { id: bigint; isOwner: boolean }[]) => {
      if (!address) return;
      setIds((current) => {
        const merged = mergeAgentIds(
          current,
          found.map((f) => f.id),
        );
        writeStored(agentCacheKey(chainId, address), merged);
        return merged;
      });
      setOwnedIds((current) =>
        mergeAgentIds(
          current,
          found.filter((f) => f.isOwner).map((f) => f.id),
        ),
      );
    },
    [address, chainId],
  );

  const addManual = useCallback(
    async (raw: string): Promise<AddAgentResult> => {
      const parsed = parseAgentIdInput(raw);
      if (!parsed.ok) return parsed;
      if (!address || !client) return { ok: false, error: "Connect your wallet first." };
      try {
        const [check] = await checkAgents(client as PublicClient, [parsed.id]);
        if (!check.owner) return { ok: false, error: `Agent #${parsed.id} does not exist on this network.` };
        const mine = controlledAgents([check], address);
        if (mine.length === 0) {
          return {
            ok: false,
            error: `Your wallet does not control agent #${parsed.id}. Connect the owner or its working wallet.`,
          };
        }
        remember(mine);
        return { ok: true, id: parsed.id };
      } catch {
        return { ok: false, error: "Could not check that agent right now. Try again in a moment." };
      }
    },
    [address, client, remember],
  );

  const scan = useCallback(async () => {
    if (!address || !client || scanning) return;
    setScanning(true);
    setScanned(0);
    try {
      const target = owned ?? 1;
      let found = 0;
      const hits: { id: bigint; isOwner: boolean }[] = [];
      for (let from = 1; from <= SCAN_LIMIT && found < target; from += SCAN_CHUNK) {
        const batch = Array.from({ length: SCAN_CHUNK }, (_, i) => BigInt(from + i));
        const results = await batchRead(
          client as PublicClient,
          batch.map((id) => ({
            address: CONTRACTS.IDENTITY_REGISTRY,
            abi: registryAbi,
            functionName: "ownerOf",
            args: [id],
          })),
        );
        results.forEach((r, i) => {
          if (r.ok && String(r.value).toLowerCase() === address.toLowerCase()) {
            hits.push({ id: batch[i], isOwner: true });
            found += 1;
          }
        });
        setScanned(from + SCAN_CHUNK - 1);
        // Ids are minted in order: a whole chunk of reverts means the end of the registry.
        if (results.every((r) => !r.ok)) break;
      }
      remember(hits);
    } catch {
      // leave what was found; the user can try again
    } finally {
      setScanning(false);
    }
  }, [address, client, owned, remember, scanning]);

  const isMine = useCallback((agentId: bigint) => ids.includes(agentId), [ids]);
  const missing = missingOwnedCount(owned, ownedIds.length);
  return { ids, status, owned, missing, scanning, scanned, addManual, scan, isMine };
}
