import type { Address } from "viem";
import type { PinnedBlock } from "./chain.js";

export type SnapshotContext = { chainId: number; adapter: Address };

/** Fields shared by every paid response: one block, named by number and hash, so the answer is reproducible. */
export function snapshotHeader(context: SnapshotContext, block: PinnedBlock) {
  return {
    chainId: context.chainId,
    adapter: context.adapter,
    contractVersion: "4.8",
    sourceBlock: block.number,
    sourceBlockHash: block.hash,
  };
}
