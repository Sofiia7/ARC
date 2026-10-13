import {
  createPublicClient,
  http,
  parseAbi,
  type Abi,
  type Address,
  type ContractFunctionReturnType,
  type Hex,
} from "viem";
import { BOUNTY_ADAPTER_V48_ABI } from "arcbounty-agent-sdk";
import { LIMITS, MULTICALL3 } from "./constants.js";

export const adapterAbi = BOUNTY_ADAPTER_V48_ABI;
export type BountyMeta = ContractFunctionReturnType<typeof adapterAbi, "view", "getBountyMeta">;
export type ContestEntry = ContractFunctionReturnType<typeof adapterAbi, "view", "getContestEntries">[number];
export type ContestStateTuple = readonly [
  entryCount: bigint,
  closedAt: bigint,
  reviewDeadline: bigint,
  resolved: boolean,
];
export type TotalsTuple = readonly [paidJobs: bigint, scoreSum: bigint];
export type MirrorRecordTuple = readonly [paidJobs: bigint, scoreSum: bigint, sourceBlock: bigint, updatedAt: bigint];

/** ERC-8004 identity registry reads used by the adapter (IMonadIdentityRegistry). */
export const identityAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

/** ReputationMirror public getters. */
export const mirrorAbi = parseAbi([
  "function records(address identityOwner, uint256 sourceChain) view returns (uint64 paidJobs, uint128 scoreSum, uint64 sourceBlock, uint256 updatedAt)",
]);

export type PinnedBlock = { number: bigint; hash: Hex; timestamp: bigint };
export type Call = { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] };
export type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };

/** The only chain surface the service uses; tests provide an in-memory implementation. */
export interface ChainClient {
  getChainId(): Promise<number>;
  getBlock(): Promise<PinnedBlock>;
  /** Batched read at `blockNumber` (latest when omitted). A reverting call yields a failure entry, not a throw. */
  call(calls: readonly Call[], blockNumber?: bigint): Promise<CallResult[]>;
}

/** A read failed or returned something unusable: answer 503 and never charge. */
export class ChainReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainReadError";
  }
}

export function unwrap<T>(result: CallResult | undefined, what: string): T {
  if (!result || result.status !== "success")
    throw new ChainReadError(`Read failed: ${what}`, { cause: result && "error" in result ? result.error : undefined });
  return result.result as T;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createViemChain(rpc: string): ChainClient {
  const client = createPublicClient({ transport: http(rpc, { timeout: 15000, retryCount: 1 }) });
  const run = async (calls: readonly Call[], blockNumber: bigint | undefined): Promise<CallResult[]> => {
    const results = await client.multicall({
      contracts: calls as never,
      multicallAddress: MULTICALL3,
      allowFailure: true,
      blockNumber,
      batchSize: 1_000_000, // one eth_call per chunk; chunking is done below
    });
    return results as CallResult[];
  };
  return {
    getChainId: () => client.getChainId(),
    async getBlock() {
      const block = await client.getBlock();
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    async call(calls, blockNumber) {
      if (calls.length === 0) return [];
      const groups = chunk(calls, LIMITS.multicallChunk);
      const out: CallResult[][] = new Array(groups.length);
      let next = 0;
      const worker = async () => {
        for (let index = next++; index < groups.length; index = next++)
          out[index] = await run(groups[index], blockNumber);
      };
      await Promise.all(Array.from({ length: Math.min(LIMITS.multicallConcurrency, groups.length) }, worker));
      return out.flat();
    },
  };
}
