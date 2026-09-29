import type { Address, PublicClient } from "viem";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "./contracts";
import { getActiveNetwork } from "./networks";
import type { BountyMeta } from "@/components/BountyCard";

// ─── Every bounty, read from contract storage ────────────────────────────────
//
// /stats and the leaderboard used to count event logs. Logs can vanish from
// view: on 2026-09-22 the first human worker's review (ArcBounty #12) found
// /stats showing 1 bounty and 0 completed and an empty all-time leaderboard
// while the board held 13, because the explorer log API had failed, the RPC
// fallback only scans recent blocks, and Blockdaemon had pruned everything
// older anyway. Storage cannot be pruned or half-indexed: `allJobIds` lists
// every jobId ever created and `getBountyMeta` holds each one's full state,
// so the counts come from here, two multicall rounds for the whole history.

const BATCH = 200;

/**
 * Adapters this network ran before the current one. Base moved to V4.7 on
 * 2026-09-28 and the public counters dropped to "0 completed" overnight,
 * though the V4.6 adapter still holds every bounty it ever ran.
 */
export const HISTORY_ADAPTERS: readonly Address[] = getActiveNetwork().legacyBountyAdapters ?? [];

/** A meta together with the adapter that holds it. */
export type SourcedMeta = BountyMeta & { adapter: Address };

async function metasOf(client: PublicClient, address: Address): Promise<SourcedMeta[]> {
  const total = (await client.readContract({
    address, abi: BOUNTY_ADAPTER_ABI, functionName: "totalBounties",
  })) as bigint;

  // jobIds are not 1..total: on Arc Testnet the escrow is shared, so ids are
  // global to it. Walk the adapter's own list instead.
  const ids: bigint[] = [];
  for (let start = 0n; start < total; start += BigInt(BATCH)) {
    const indexes: bigint[] = [];
    for (let i = start; i < total && i < start + BigInt(BATCH); i++) indexes.push(i);
    const batch = await client.multicall({
      allowFailure: false,
      contracts: indexes.map(i => ({
        address, abi: BOUNTY_ADAPTER_ABI, functionName: "allJobIds" as const, args: [i] as const,
      })),
    });
    ids.push(...(batch as bigint[]));
  }

  const metas: BountyMeta[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = await client.multicall({
      allowFailure: false,
      contracts: ids.slice(i, i + BATCH).map(id => ({
        address, abi: BOUNTY_ADAPTER_ABI, functionName: "getBountyMeta" as const, args: [id] as const,
      })),
    });
    metas.push(...(batch as unknown as BountyMeta[]));
  }
  return metas.map(m => ({ ...m, adapter: address }));
}

/**
 * Every bounty on the current adapter; with `withHistory`, the network's
 * earlier adapters too. Only counts use the history: anything that sends a
 * transaction works on CONTRACTS.BOUNTY_ADAPTER alone. The adapters share one
 * escrow, whose job counter numbers them all, so a jobId is never reused.
 */
export async function fetchAllBountyMetas(
  client: PublicClient,
  { withHistory = false }: { withHistory?: boolean } = {},
): Promise<SourcedMeta[]> {
  const adapters = [CONTRACTS.BOUNTY_ADAPTER, ...(withHistory ? HISTORY_ADAPTERS : [])];
  // One adapter after another: in parallel the extra reads were exactly what
  // tipped mainnet.base.org into "over rate limit" on a single page load.
  const perAdapter: SourcedMeta[][] = [];
  for (const a of adapters) perAdapter.push(await metasOf(client, a));
  const seen = new Set<string>();
  return perAdapter.flat().filter(m => {
    const id = m.jobId.toString();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The poster took its own bounty. That happens in test runs (BaseBounty #1
 * and #2 were the deployer paying itself), and it is no one's work done for
 * someone else, so it counts neither as completed nor as a worker.
 */
function isSelfTake(m: BountyMeta): boolean {
  return m.assignedProvider.toLowerCase() === m.poster.toLowerCase();
}

/**
 * The worker was paid: the poster approved or anyone auto-approved. Storage
 * does not record who won a dispute, so a bounty that went through a
 * rejection or a dispute is left out of the paid counts rather than guessed
 * at; none on Arc mainnet had, as of 2026-09-23. Self-takes are left out too.
 */
export function isPaidToWorker(m: BountyMeta): boolean {
  return m.resolved && m.submittedResultHash.length > 0 && m.rejectedAt === 0n && m.disputeRaisedAt === 0n
    && !isSelfTake(m);
}

/** The wallet that took the bounty, or null if nobody else did. */
export function workerOf(m: BountyMeta): string | null {
  return m.assignedProvider && m.assignedProvider !== ZERO && !isSelfTake(m) ? m.assignedProvider.toLowerCase() : null;
}
