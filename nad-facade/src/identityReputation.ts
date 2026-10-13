import { zeroAddress, type Address } from "viem";
import { averageScore } from "./format.js";
import { tierGates } from "./gate.js";
import { snapshotHeader, type SnapshotContext } from "./snapshot.js";
import type { PinnedBlock } from "./chain.js";

export const MIRROR_SOURCES = [
  { sourceChain: 8453n, chain: "base" },
  { sourceChain: 5042n, chain: "arc" },
] as const;

export type Totals = { paidJobs: bigint; scoreSum: bigint };
export type MirrorRecord = Totals & { sourceBlock: bigint; updatedAt: bigint };

export type ReputationInput = {
  context: SnapshotContext;
  block: PinnedBlock;
  agentId: bigint;
  identityOwner: Address;
  workingWallet: Address | null;
  mirror: Address;
  local: Totals;
  /** One record per MIRROR_SOURCES entry, in the same order. */
  records: readonly MirrorRecord[];
  /** The adapter's own getIdentityReputation(agentId, 0x0) at the same block. */
  onChainTotals: Totals;
};

function describe(totals: Totals) {
  return {
    paidJobs: totals.paidJobs.toString(),
    scoreSum: totals.scoreSum.toString(),
    averageScore: averageScore(totals.paidJobs, totals.scoreSum),
  };
}

/** Sum the three sources exactly as the adapter does (scoreSums add; averages are never added or averaged). */
export function combineTotals(local: Totals, records: readonly Totals[]): Totals {
  return records.reduce(
    (sum, record) => ({ paidJobs: sum.paidJobs + record.paidJobs, scoreSum: sum.scoreSum + record.scoreSum }),
    local,
  );
}

export function buildReputationBody(input: ReputationInput) {
  if (input.records.length !== MIRROR_SOURCES.length) throw new Error("Unexpected mirror record count");
  const combined = combineTotals(input.local, input.records);
  // The adapter is the source of truth for the totals it gates on; refuse to publish numbers that disagree with it.
  if (combined.paidJobs !== input.onChainTotals.paidJobs || combined.scoreSum !== input.onChainTotals.scoreSum) {
    throw new Error("Reputation parts disagree with the adapter total");
  }
  return {
    ...snapshotHeader(input.context, input.block),
    agentId: input.agentId.toString(),
    identityOwner: input.identityOwner,
    workingWallet: input.workingWallet && input.workingWallet !== zeroAddress ? input.workingWallet : null,
    local: describe(input.local),
    mirror: {
      address: input.mirror,
      note: "Base and Arc records are relayer-reported snapshots keyed by the current identity owner; sourceBlock is provenance, not a proof.",
      records: MIRROR_SOURCES.map((source, index) => ({
        sourceChain: Number(source.sourceChain),
        chain: source.chain,
        ...describe(input.records[index]),
        sourceBlock: input.records[index].sourceBlock.toString(),
        updatedAt: input.records[index].updatedAt.toString(),
      })),
    },
    combined: describe(combined),
    gates: tierGates(combined.paidJobs, combined.scoreSum),
  };
}
