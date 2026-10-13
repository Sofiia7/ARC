import { zeroAddress, type Address } from "viem";
import type { BountyMeta, ContestEntry, PinnedBlock } from "./chain.js";
import { CONTRACT } from "./constants.js";
import { timestamp, usdcAmount } from "./format.js";
import { snapshotHeader, type SnapshotContext } from "./snapshot.js";

export type ContestSplit = { fee: bigint; net: bigint; amounts: bigint[] };

/**
 * Normal contest settlement, as _settleContest computes it: fee = reward * feeBps / 10000 (floored), the net is split
 * evenly between the awarded entries and the integer remainder goes to the first awarded entry.
 * The arbitrator-timeout split and the escrow-recovery path pay differently and are not modelled here.
 */
export function splitContestPayout(reward: bigint, feeBps: bigint, winners: number): ContestSplit {
  if (!Number.isInteger(winners) || winners < 0) throw new Error("Invalid winner count");
  const fee = (reward * feeBps) / CONTRACT.bpsDenominator;
  const net = reward - fee;
  if (winners === 0) return { fee, net, amounts: [] };
  const count = BigInt(winners);
  const share = net / count;
  const remainder = net % count;
  return { fee, net, amounts: Array.from({ length: winners }, (_, index) => share + (index === 0 ? remainder : 0n)) };
}

export type ContestState =
  | "open"
  | "closed_no_entries"
  | "in_review"
  | "review_expired"
  | "rejection_challenge_window"
  | "rejection_unchallenged"
  | "in_dispute"
  | "settled"
  | "refunded";

export const STATE_DESCRIPTIONS: Record<ContestState, string> = {
  open: "Accepting entries; the poster cannot pick winners yet.",
  closed_no_entries: "Closed without entries; the poster can be refunded (expireBounty or cancelBounty).",
  in_review: "Closed to new entries; the poster can pick winners until reviewDeadline.",
  review_expired:
    "Review window ended without a decision; anyone can settle (settleContestSilence), all entries are awarded.",
  rejection_challenge_window: "The poster rejected every entry; entrants can challenge for 48 hours.",
  rejection_unchallenged: "Rejection stood unchallenged; anyone can finalize the refund (finalizeContestRejection).",
  in_dispute: "At least one rejection was challenged; the arbitrator (or a default ruling) decides.",
  settled: "Settled; the awarded entries were paid.",
  refunded: "Settled with no winners; the reward went back to the poster.",
};

export type StateInput = {
  resolved: boolean;
  rejectedAt: bigint;
  inDispute: boolean;
  entryCount: bigint;
  closedAt: bigint;
  reviewDeadline: bigint;
  awardedCount: number;
  challengerCount: number;
  now: bigint;
};

export function deriveContestState(input: StateInput): ContestState {
  if (input.resolved) return input.awardedCount > 0 ? "settled" : "refunded";
  if (input.rejectedAt !== 0n) {
    if (input.challengerCount > 0 || input.inDispute) return "in_dispute";
    return input.now <= input.rejectedAt + CONTRACT.rejectionChallengeWindowSeconds
      ? "rejection_challenge_window"
      : "rejection_unchallenged";
  }
  if (input.closedAt === 0n) return "open";
  if (input.entryCount === 0n) return "closed_no_entries";
  return input.now <= input.reviewDeadline ? "in_review" : "review_expired";
}

export type ContestInput = {
  context: SnapshotContext;
  block: PinnedBlock;
  jobId: bigint;
  meta: BountyMeta;
  entries: readonly ContestEntry[];
  contestState: readonly [entryCount: bigint, closedAt: bigint, reviewDeadline: bigint, resolved: boolean];
  challengers: readonly number[];
  feeBps: bigint;
  /** Current identity owner per agent ID; null when the registry cannot resolve one (the payout is then parked). */
  owners: ReadonlyMap<bigint, Address | null>;
};

/** Response body for GET /v1/contests/{jobId}/result. Ciphertext CIDs only: nothing is ever decrypted. */
export function buildContestBody(input: ContestInput) {
  const { meta, entries } = input;
  const [entryCount, closedAt, reviewDeadline, resolved] = input.contestState;
  const awarded = entries.flatMap((entry, index) => (entry.awarded ? [index] : []));
  const state = deriveContestState({
    resolved,
    rejectedAt: meta.rejectedAt,
    inDispute: meta.inDispute,
    entryCount,
    closedAt,
    reviewDeadline,
    awardedCount: awarded.length,
    challengerCount: input.challengers.length,
    now: input.block.timestamp,
  });
  const split = splitContestPayout(meta.reward, input.feeBps, awarded.length);
  const amountByIndex = new Map(awarded.map((index, position) => [index, split.amounts[position]]));
  const challenged = new Set(input.challengers);
  return {
    ...snapshotHeader(input.context, input.block),
    sourceBlockTimestamp: input.block.timestamp.toString(),
    jobId: input.jobId.toString(),
    state,
    stateDescription: STATE_DESCRIPTIONS[state],
    poster: meta.poster,
    reward: usdcAmount(meta.reward),
    maxEntries: meta.maxEntries,
    winnersAllowed: meta.winners,
    gate: { minJobs: meta.minJobs.toString(), minAvgScore: meta.minAvgScore },
    timeline: {
      deadline: timestamp(meta.deadline),
      closedAt: timestamp(closedAt),
      reviewDeadline: timestamp(reviewDeadline),
      rejectedAt: timestamp(meta.rejectedAt),
    },
    entryCount: entryCount.toString(),
    entries: entries.map((entry, index) => {
      const owner = entry.agentId === 0n ? entry.entrant : (input.owners.get(entry.agentId) ?? null);
      const amount = amountByIndex.get(index);
      return {
        index,
        agentId: entry.agentId.toString(),
        entrant: entry.entrant,
        ciphertextCid: entry.resultHash,
        awarded: entry.awarded,
        challenged: challenged.has(index),
        score: null,
        identityOwner: entry.agentId === 0n ? null : owner,
        payout:
          amount === undefined
            ? null
            : {
                recipient: owner && owner !== zeroAddress ? owner : null,
                parked: !owner || owner === zeroAddress,
                net: usdcAmount(amount),
              },
      };
    }),
    settlement:
      awarded.length > 0
        ? {
            basis:
              "standard: fee = reward * feeBps / 10000 (floored), net split evenly, remainder to the first awarded entry",
            feeBps: input.feeBps.toString(),
            fee: usdcAmount(split.fee),
            net: usdcAmount(split.net),
            winners: awarded.length,
            recipientNote:
              "Recipients are the identity owners at sourceBlock (never the working wallet). If an identity changed hands after settlement, the original payee may differ. Contests settled by the arbitrator timeout or escrow recovery pay differently; the ContestAwarded events are authoritative.",
          }
        : null,
    scores: {
      available: false,
      note: "Per-entry scores are only emitted in ContestAwarded events; the facade does not scan logs. Aggregated results are available from GET /v1/reputation/{agentId}.",
    },
  };
}
