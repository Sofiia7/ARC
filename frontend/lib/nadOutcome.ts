// Pure NadBounty outcome: who was paid what (or refunded) for a resolved bounty, rebuilt from storage reads only.
// No React, no wagmi, no network: safe to import from node:test. The Monad public RPC caps eth_getLogs at 100 blocks,
// so nothing here depends on event logs.
//
// Rules, verified against contracts/src/monad/BountyAdapterV48.sol (see also lib/nadStats.ts, whose fee and split
// helpers are reused so the two cannot disagree):
// * Fee: reward * feeBps / 10_000 (feeBps is an immutable 100) is paid to feeRecipient on a normal payout only:
//   approveBounty, autoApprove, a dispute ruled for the worker, and every contest award (_settleContest).
//   No fee on refunds, on claimArbitratorTimeout (50/50), on claimContestArbitratorTimeout, or on anything paid by
//   reconcileExpiredEscrow (the escrow had already expired).
// * Single taker worker payout goes to the identity owner of agentId, or to the wallet for a human (_payWorker).
// * Contest payout (_settleContest): net = reward - fee, share = net / n, remainder = net % n goes to the FIRST
//   winner in the order the poster listed them. That order is not stored, so every winner is reported at `share`
//   and the remainder is reported separately (it is at most n - 1 micro-USDC).
// * The contract stores no per-job score (only an aggregate in localReputation and a ReputationRegistry feedback),
//   so no score is reported here.
// * A worker deposit (bond) is refunded at submitWork and forfeited to the poster only when the bounty expires taken
//   but unsubmitted (expireBounty, reconcileExpiredEscrow).
import { type Meta, reconcileShare, resolutionOf } from "./nadStatus";
import { halves, workerBondFor } from "./nadMoney";
import { DEFAULT_FEE_BPS, ESCROW_STATUS, formatUsdcUnits, nadFee, splitContestNet } from "./nadStats";

export type OutcomeMeta = Pick<
  Meta,
  | "contest"
  | "poster"
  | "reward"
  | "deadline"
  | "resolved"
  | "agentId"
  | "assignedProvider"
  | "isTaken"
  | "submittedResultHash"
  | "rejectedAt"
  | "disputeRaisedAt"
  | "disputeResponseHash"
  | "disputeRulingHash"
  | "disputeByWorker"
  | "requireWorkerBond"
>;
export type OutcomeEntry = { agentId: bigint; entrant: string; resultHash: string; awarded: boolean };
export type OutcomeChallenge = { challengedAt: bigint; respondedAt: bigint };

export type OutcomeInput = {
  meta: OutcomeMeta;
  /** AgenticCommerce getJob(jobId).status. */
  escrowStatus?: number;
  /** getContestEntries (contest only). */
  entries?: readonly OutcomeEntry[];
  /** getContestChallenge for each entry (contest only). */
  challenges?: readonly OutcomeChallenge[];
  /** The adapter's feeBps (defaults to 100). */
  feeBps?: bigint;
  /** Chain time, used only to tell "cancelled" from "never taken". */
  now?: bigint;
  /** Current identity owner by agent id (as a decimal string). */
  owners?: Readonly<Record<string, string | null | undefined>>;
  /** The adapter's feeRecipient. */
  feeRecipient?: string | null;
};

export type PayeeRole = "worker" | "winner" | "poster";
export type Payee = {
  role: PayeeRole;
  /** 0 for a human wallet and for the poster. */
  agentId: bigint;
  /** Contest entry index, or null. */
  entryIndex: number | null;
  /** Wallet that received the money when known (identity owner for an agent, the wallet for a human). */
  address: string | null;
  amount: bigint;
  /** "the identity owner of agent #12", "the wallet that took it", "the poster". */
  who: string;
};

export type RefundReason =
  | "cancelled"
  | "no-taker"
  | "no-entries"
  | "worker-vanished"
  | "rejection-final"
  | "dispute-poster"
  | "contest-rejected"
  | "contest-ruling"
  | "escrow-expired";

export type OutcomeResult = {
  /** IPFS URI or CID exactly as stored on chain. */
  cid: string;
  /** Contest entries are ciphertext: only the poster can read them. */
  sealed: boolean;
  entryIndex: number | null;
  agentId: bigint;
};

export type Outcome = {
  kind: "paid" | "split" | "refunded" | "unknown";
  /** Short heading: "Paid", "Split 50/50", "Refunded to the poster", "Settled". */
  title: string;
  /** The escrowed reward. */
  gross: bigint;
  /** Protocol fee, paid to feeRecipient. */
  fee: bigint;
  feeRecipient: string | null;
  /** Everyone who received money from the reward (workers, winners, and the poster on a split). */
  payees: Payee[];
  /** Returned to the poster: a refund, the poster's half of a split, plus any forfeited deposit. */
  posterRefund: bigint;
  /** Worker deposit forfeited to the poster (already counted in posterRefund). */
  forfeitedBond: bigint;
  /** Contest rounding: base units that went to the first winner in the poster's order. */
  remainder: bigint;
  reason: RefundReason | null;
  reasonText: string | null;
  results: OutcomeResult[];
  /** True when storage cannot tell two payout shapes apart (see notes). */
  approximate: boolean;
  notes: string[];
};

export const REFUND_REASON_TEXT: Record<RefundReason, string> = {
  cancelled: "The poster cancelled before anyone took part, so the full reward went back to the poster.",
  "no-taker":
    "Nobody took this bounty before its deadline (or the poster cancelled it), so the full reward went back to the poster.",
  "no-entries":
    "Nobody entered this contest before its deadline (or the poster cancelled it), so the full reward went back to the poster.",
  "worker-vanished":
    "The worker took the bounty but did not submit before the deadline, so the reward went back to the poster.",
  "rejection-final": "The poster rejected the work and nobody challenged within 48 hours, so the reward was refunded.",
  "dispute-poster":
    "The dispute was decided for the poster (by the arbitrator or by default), so the reward was refunded.",
  "contest-rejected":
    "The poster rejected all entries and nobody challenged within 48 hours, so the reward was refunded.",
  "contest-ruling": "The poster rejected all entries, entrants challenged, and the arbitrator ruled for a refund.",
  "escrow-expired":
    "Nobody settled this job within 90 days of its deadline, so the escrow expired and the funds were recovered with no fee.",
};

const FEE_NOTE = "A 1% protocol fee was taken from the payout.";

function who(agentId: bigint, human: string): string {
  return agentId === 0n ? human : `the identity owner of agent #${agentId}`;
}

function payeeAddress(agentId: bigint, wallet: string, owners: OutcomeInput["owners"]): string | null {
  if (agentId === 0n) return wallet;
  return owners?.[String(agentId)] ?? null;
}

/** Returns null while the bounty is not resolved. */
export function computeOutcome(input: OutcomeInput): Outcome | null {
  const { meta } = input;
  if (!meta.resolved) return null;
  const feeBps = input.feeBps ?? DEFAULT_FEE_BPS;
  const entries = input.entries ?? [];
  const challenges = input.challenges ?? [];
  const challengers = challenges.flatMap((c, i) => (c.challengedAt > 0n ? [i] : []));
  const awardedIdx = entries.flatMap((e, i) => (e.awarded ? [i] : []));
  const escrow = input.escrowStatus;
  const reward = meta.reward;
  const base = {
    gross: reward,
    fee: 0n,
    feeRecipient: input.feeRecipient ?? null,
    payees: [] as Payee[],
    posterRefund: 0n,
    forfeitedBond: 0n,
    remainder: 0n,
    reason: null as RefundReason | null,
    reasonText: null as string | null,
    results: [] as OutcomeResult[],
    approximate: false,
    notes: [] as string[],
  };
  const resolution = resolutionOf(meta, {
    escrowStatus: escrow,
    anyAwarded: meta.contest ? awardedIdx.length > 0 : undefined,
  });
  const refund = (reason: RefundReason | null, extra: Partial<Outcome> = {}): Outcome => {
    const posterRefund = reward + (extra.forfeitedBond ?? 0n);
    return {
      ...base,
      kind: "refunded",
      title: "Refunded to the poster",
      posterRefund,
      reason,
      reasonText: reason ? REFUND_REASON_TEXT[reason] : null,
      notes: ["No protocol fee was charged on this refund."],
      ...extra,
      payees: [
        {
          role: "poster",
          agentId: 0n,
          entryIndex: null,
          address: meta.poster,
          amount: posterRefund,
          who: "the poster",
        },
      ],
    };
  };

  if (resolution === "settled") {
    return {
      ...base,
      kind: "unknown",
      title: "Settled",
      notes: ["The escrow status could not be read, so the exact payout is not shown."],
    };
  }

  // ───────── contest ─────────
  if (meta.contest) {
    if (resolution === "refunded" || resolution === "expired-refunded") {
      const reason: RefundReason =
        resolution === "expired-refunded"
          ? "escrow-expired"
          : entries.length === 0
            ? input.now !== undefined && input.now < meta.deadline
              ? "cancelled"
              : "no-entries"
            : challengers.length > 0
              ? "contest-ruling"
              : "contest-rejected";
      return refund(reason);
    }
    // A contest award. n >= 1 whenever the escrow shows Completed or Expired with awards.
    const n = awardedIdx.length;
    if (n === 0) {
      return {
        ...base,
        kind: "unknown",
        title: "Settled",
        notes: ["The contest is settled but no entry is marked as awarded."],
      };
    }
    const recovered = escrow === ESCROW_STATUS.Expired;
    const rejected = meta.rejectedAt > 0n;
    const allResponded = challengers.length > 0 && challengers.every((i) => challenges[i].respondedAt > 0n);
    let fee = 0n;
    let pool = reward;
    let posterRefund = 0n;
    const notes: string[] = [];
    let approximate = false;
    if (!recovered) {
      fee = nadFee(reward, feeBps);
      pool = reward - fee;
      notes.push(FEE_NOTE);
      if (rejected) {
        approximate = true;
        notes.push(
          "This contest was rejected and challenged. Winners share the payout after the fee when the poster accepted them, the arbitrator ruled, or the poster did not answer; if the arbitrator timed out instead, half of the reward went back to the poster and the winners shared the other half with no fee. Storage cannot tell these apart.",
        );
      }
    } else {
      notes.push("The escrow had expired, so the funds were recovered with no protocol fee.");
      if (rejected && allResponded) {
        const split = halves(reward);
        posterRefund = split.poster;
        pool = split.worker;
        notes.push(
          "Both sides had answered and the arbitrator never ruled, so the reward was split 50/50 with the poster.",
        );
      }
    }
    const amounts = splitContestNet(pool, n);
    const remainder = pool % BigInt(n);
    const payees = awardedIdx.map((index, i): Payee => {
      const entry = entries[index];
      return {
        role: "winner",
        agentId: entry.agentId,
        entryIndex: index,
        address: payeeAddress(entry.agentId, entry.entrant, input.owners),
        // The remainder belongs to the first winner in the poster's order, which is not stored: report the base share.
        amount: amounts[i] - (i === 0 ? remainder : 0n),
        who: who(entry.agentId, "the entrant wallet"),
      };
    });
    if (posterRefund > 0n) {
      payees.push({
        role: "poster",
        agentId: 0n,
        entryIndex: null,
        address: meta.poster,
        amount: posterRefund,
        who: "the poster",
      });
    }
    if (remainder > 0n)
      notes.push(
        `${formatUsdcUnits(remainder)} USDC of rounding went to the first winner in the order the poster listed them.`,
      );
    notes.push("Entries are encrypted: only the poster can read them.");
    return {
      ...base,
      kind: "paid",
      title: "Paid",
      fee,
      payees,
      posterRefund,
      remainder,
      approximate,
      notes,
      results: awardedIdx.map((index) => ({
        cid: entries[index].resultHash,
        sealed: true,
        entryIndex: index,
        agentId: entries[index].agentId,
      })),
    };
  }

  // ───────── single taker ─────────
  const submitted = meta.submittedResultHash !== "";
  const results: OutcomeResult[] = submitted
    ? [{ cid: meta.submittedResultHash, sealed: false, entryIndex: null, agentId: meta.agentId }]
    : [];
  const workerWho = who(meta.agentId, "the wallet that took it");
  const worker = (amount: bigint): Payee => ({
    role: "worker",
    agentId: meta.agentId,
    entryIndex: null,
    address: payeeAddress(meta.agentId, meta.assignedProvider, input.owners),
    amount,
    who: workerWho,
  });
  const poster = (amount: bigint): Payee => ({
    role: "poster",
    agentId: 0n,
    entryIndex: null,
    address: meta.poster,
    amount,
    who: "the poster",
  });
  const bond = meta.requireWorkerBond && meta.isTaken && !submitted ? workerBondFor(reward) : 0n;
  const bondNote =
    bond > 0n ? [`The worker's deposit of ${formatUsdcUnits(bond)} USDC was forfeited to the poster.`] : [];

  if (escrow === ESCROW_STATUS.Expired) {
    const share = reconcileShare(meta);
    const noFee = "The escrow had expired, so the funds were recovered with no protocol fee.";
    if (share === "worker") {
      return { ...base, kind: "paid", title: "Paid", payees: [worker(reward)], results, notes: [noFee] };
    }
    if (share === "split") {
      const split = halves(reward);
      return {
        ...base,
        kind: "split",
        title: "Split 50/50",
        payees: [worker(split.worker), poster(split.poster)],
        posterRefund: split.poster,
        results,
        notes: [noFee, "Both sides had answered and the arbitrator never ruled."],
      };
    }
    return refund("escrow-expired", { forfeitedBond: bond, results, notes: [noFee, ...bondNote] });
  }
  if (resolution === "split") {
    const split = halves(reward);
    return {
      ...base,
      kind: "split",
      title: "Split 50/50",
      payees: [worker(split.worker), poster(split.poster)],
      posterRefund: split.poster,
      results,
      notes: ["The arbitrator did not rule within 30 days, so the reward was split 50/50 with no protocol fee."],
    };
  }
  if (resolution === "paid") {
    const fee = nadFee(reward, feeBps);
    return {
      ...base,
      kind: "paid",
      title: "Paid",
      fee,
      payees: [worker(reward - fee)],
      results,
      notes: [FEE_NOTE],
    };
  }
  // Refunded: escrow Open (never taken) or Rejected.
  let reason: RefundReason | null = null;
  if (escrow === ESCROW_STATUS.Open) {
    reason = input.now !== undefined && input.now <= meta.deadline ? "cancelled" : "no-taker";
  } else if (!submitted) {
    reason = "worker-vanished";
  } else if (meta.disputeRaisedAt > 0n) {
    reason = "dispute-poster";
  } else if (meta.rejectedAt > 0n) {
    reason = "rejection-final";
  }
  return refund(reason, {
    forfeitedBond: bond,
    results,
    notes: ["No protocol fee was charged on this refund.", ...bondNote],
  });
}
