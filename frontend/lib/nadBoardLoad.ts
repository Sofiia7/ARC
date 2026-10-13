// Chain reads for the NadBounty board and My Tasks. React-free; takes any viem-shaped client.
//
// Monad's public RPC caps eth_getLogs at 100 blocks, so nothing here reads event logs. Everything is a view call,
// grouped through Multicall3 so a full board is four small requests instead of one request per bounty.
import { parseAbi, type Abi, type Address } from "viem";
import { BOUNTY_ADAPTER_V48_ABI as ABI } from "./abi-v48";
import {
  BOARD_LIMIT,
  ESCROW_STATUS,
  latestIndexRange,
  makeJob,
  mergeJobIds,
  normalizeEscrowStatus,
  type ContestState,
  type NadJob,
} from "./nadBoard";
import type { Meta } from "./nadStatus";

const escrowAbi = parseAbi([
  "function getJob(uint256) view returns((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))",
]);

/** The slice of a viem PublicClient this module needs (kept loose so wagmi's generic client is assignable). */
export interface NadReadClient {
  chain?: unknown;
  multicall(args: any): Promise<any>;
  readContract(args: any): Promise<any>;
  getBlock(args?: any): Promise<{ timestamp: bigint }>;
}
export type NadChainCfg = { adapter: Address; escrow: Address };
export type ReadCall = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
export type ReadResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };

export type NadSnapshot = {
  jobs: NadJob[];
  /** totalBounties at fetch time (the board) or the number of ids read (My Tasks). */
  total: bigint;
  /** Block timestamp at fetch time. Add the seconds since fetchedAtMs to get chain time now. */
  chainNow: bigint;
  fetchedAtMs: number;
  /** True when more jobs exist than the hard cap allowed us to read. */
  truncated: boolean;
  /** Jobs whose meta could not be read and were left out. */
  skipped: number;
};

const hasMulticall = (client: NadReadClient) =>
  !!(client.chain as { contracts?: { multicall3?: unknown } } | undefined)?.contracts?.multicall3;

/**
 * One batched read. Uses Multicall3 when the chain has it (Monad mainnet); on a chain without it (Monad testnet) it
 * falls back to parallel eth_calls, which the wagmi transport still coalesces into one JSON-RPC batch.
 */
export async function readMany(
  client: NadReadClient,
  calls: readonly ReadCall[],
  batchSize = 32_768,
): Promise<ReadResult[]> {
  if (!calls.length) return [];
  if (hasMulticall(client)) {
    const results = await client.multicall({ contracts: calls, allowFailure: true, batchSize });
    return results as ReadResult[];
  }
  return Promise.all(
    calls.map(async (call): Promise<ReadResult> => {
      try {
        return { status: "success", result: await client.readContract(call) };
      } catch (error) {
        return { status: "failure", error };
      }
    }),
  );
}

/** Metas, escrow status and (for contests) contest state for the given ids, in the given order. */
export async function hydrateJobs(
  client: NadReadClient,
  cfg: NadChainCfg,
  ids: readonly bigint[],
  chainNow: bigint,
): Promise<{ jobs: NadJob[]; skipped: number }> {
  if (!ids.length) return { jobs: [], skipped: 0 };
  const first = await readMany(client, [
    ...ids.map((id) => ({ address: cfg.adapter, abi: ABI as Abi, functionName: "getBountyMeta", args: [id] })),
    ...ids.map((id) => ({ address: cfg.escrow, abi: escrowAbi as Abi, functionName: "getJob", args: [id] })),
  ]);
  const metas = first.slice(0, ids.length),
    escrow = first.slice(ids.length);
  const contestSlots: number[] = [];
  metas.forEach((r, i) => {
    if (r.status === "success" && (r.result as Meta).contest) contestSlots.push(i);
  });
  const contestRes = await readMany(
    client,
    contestSlots.map((i) => ({
      address: cfg.adapter,
      abi: ABI as Abi,
      functionName: "getContestState",
      args: [ids[i]],
    })),
  );
  const contestAt = new Map<number, ContestState>();
  contestSlots.forEach((slot, k) => {
    const r = contestRes[k];
    if (r?.status === "success") contestAt.set(slot, r.result as ContestState);
  });
  const escrowStatusAt = (i: number): unknown => {
    const res = escrow[i];
    return res?.status === "success" ? (res.result as { status?: unknown }).status : undefined;
  };
  // Only a resolved contest whose escrow job expired needs its entries: whether anyone was awarded tells a payout
  // from a refund (reconcileExpiredEscrow). Everything else is decided by the escrow status alone.
  const awardSlots = contestSlots.filter((i) => {
    const m = metas[i];
    return (
      m.status === "success" &&
      (m.result as Meta).resolved &&
      normalizeEscrowStatus(escrowStatusAt(i)) === ESCROW_STATUS.Expired
    );
  });
  const awardRes = await readMany(
    client,
    awardSlots.map((i) => ({
      address: cfg.adapter,
      abi: ABI as Abi,
      functionName: "getContestEntries",
      args: [ids[i]],
    })),
  );
  const awardedAt = new Map<number, boolean>();
  awardSlots.forEach((slot, k) => {
    const r = awardRes[k];
    if (r?.status === "success")
      awardedAt.set(
        slot,
        (r.result as readonly { awarded: boolean }[]).some((e) => e.awarded),
      );
  });
  const jobs: NadJob[] = [];
  let skipped = 0;
  metas.forEach((r, i) => {
    if (r.status !== "success") {
      skipped++;
      return;
    }
    jobs.push(
      makeJob(r.result as Meta, {
        escrowStatus: escrowStatusAt(i),
        contestState: contestAt.get(i) ?? null,
        anyAwarded: awardedAt.get(i),
        nowSeconds: chainNow,
      }),
    );
  });
  if (!jobs.length) throw new Error("Could not read bounties from the RPC");
  return { jobs, skipped };
}

/** The newest `limit` bounties of the adapter, any state, with statuses refined by escrow and contest data. */
export async function loadNadBoard(client: NadReadClient, cfg: NadChainCfg, limit = BOARD_LIMIT): Promise<NadSnapshot> {
  const [total, block] = await Promise.all([
    client.readContract({ address: cfg.adapter, abi: ABI, functionName: "totalBounties" }) as Promise<bigint>,
    client.getBlock({ blockTag: "latest" }),
  ]);
  const chainNow = block.timestamp;
  const { start, count } = latestIndexRange(total, limit);
  const idRes = await readMany(
    client,
    Array.from({ length: count }, (_, i) => ({
      address: cfg.adapter,
      abi: ABI as Abi,
      functionName: "allJobIds",
      args: [start + BigInt(i)],
    })),
  );
  const ids = idRes.flatMap((r) => (r.status === "success" ? [r.result as bigint] : []));
  const fetchedAtMs = Date.now();
  if (total > 0n && !ids.length) throw new Error("Could not read bounty ids from the RPC");
  const { jobs, skipped } = await hydrateJobs(client, cfg, ids, chainNow);
  return { jobs, total, chainNow, fetchedAtMs, truncated: total > BigInt(limit), skipped };
}

/** Bounties a wallet posted or was assigned, plus an agent's history, newest first and cut to `limit`. */
export async function loadMyJobIds(
  client: NadReadClient,
  cfg: NadChainCfg,
  who: { address: Address; agentId: bigint },
  limit = BOARD_LIMIT,
): Promise<{ ids: bigint[]; truncated: boolean }> {
  const calls: ReadCall[] = [
    { address: cfg.adapter, abi: ABI as Abi, functionName: "getMyPostedBounties", args: [who.address] },
    { address: cfg.adapter, abi: ABI as Abi, functionName: "getMyAssignedBounties", args: [who.address] },
  ];
  if (who.agentId > 0n)
    calls.push({ address: cfg.adapter, abi: ABI as Abi, functionName: "getAgentBounties", args: [who.agentId] });
  const results = await readMany(client, calls);
  const lists = results.map((r) => {
    if (r.status !== "success") throw new Error("Could not read your task list from the RPC");
    return r.result as readonly bigint[];
  });
  const all = mergeJobIds(lists, Number.MAX_SAFE_INTEGER);
  return { ids: all.slice(0, limit), truncated: all.length > limit };
}

/** Full snapshot for a list of ids (My Tasks). */
export async function loadNadJobs(
  client: NadReadClient,
  cfg: NadChainCfg,
  ids: readonly bigint[],
): Promise<NadSnapshot> {
  const block = await client.getBlock({ blockTag: "latest" });
  const chainNow = block.timestamp;
  const fetchedAtMs = Date.now();
  const { jobs, skipped } = await hydrateJobs(client, cfg, ids, chainNow);
  return { jobs, total: BigInt(ids.length), chainNow, fetchedAtMs, truncated: false, skipped };
}
