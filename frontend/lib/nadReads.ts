// Batched view reads for the NadBounty pages. One Multicall3 request instead of one eth_call per value, which keeps
// the public RPC (rate limited, eth_getLogs capped at 100 blocks) quiet. Never uses event logs.
import type { Abi, Address, PublicClient } from "viem";
import { getActiveNetwork } from "./networks";

export type ReadCall = {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};
export type ReadResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * Reads every call, failures included, in one round trip when the network has Multicall3 (monad-mainnet does,
 * monad-testnet does not and falls back to parallel eth_calls). A failed call (a revert) never rejects the batch:
 * check `.ok` on each result.
 */
export async function batchRead(
  client: PublicClient,
  calls: readonly ReadCall[],
  blockNumber?: bigint,
): Promise<ReadResult[]> {
  if (calls.length === 0) return [];
  if (getActiveNetwork().multicall3) {
    type Settled = { status: "success"; result: unknown } | { status: "failure"; error: unknown };
    const results = (await client.multicall({
      contracts: calls as never,
      allowFailure: true,
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      // One eth_call for the whole batch instead of several 1 KB slices.
      batchSize: 1 << 16,
    } as never)) as unknown as Settled[];
    return results.map(
      (r): ReadResult => (r.status === "success" ? { ok: true, value: r.result } : { ok: false, error: r.error }),
    );
  }
  return Promise.all(
    calls.map(async (call): Promise<ReadResult> => {
      try {
        const value = await client.readContract({
          address: call.address,
          abi: call.abi as Abi,
          functionName: call.functionName,
          args: call.args as never,
          ...(blockNumber !== undefined ? { blockNumber } : {}),
        });
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error };
      }
    }),
  );
}
