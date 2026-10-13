// Pure NadBounty stats helpers. No React, no wagmi, no network, no env: safe to import from node:test and from
// client pages.
//
// The Monad public RPC caps eth_getLogs at 100 blocks, so the stats are rebuilt from storage only: getBountyMeta,
// the escrow's job status, getContestEntries and the identity registry's ownerOf (all view reads, batched with
// Multicall3 by app/api/nad/stats/route.ts). Payouts are re-derived with the contract's own integer arithmetic.
//
// Rules verified against contracts/src/monad/BountyAdapterV48.sol and contracts/src/base/AgenticCommerce.sol:
//
// * AgenticCommerce.JobStatus is Open 0, Funded 1, Submitted 2, Completed 3, Rejected 4, Expired 5. Completed means
//   the escrow released the reward to the adapter (paid out), Rejected means it was refunded to the poster.
// * Single-taker approve / auto-approve / dispute-for-worker (_completeAndForward): fee = reward * feeBps / 10_000,
//   the worker's identity owner receives reward - fee. feeBps is an immutable 100 (1%).
// * Contest settlement (_settleContest): fee = reward * feeBps / 10_000, net = reward - fee, share = net / n and
//   remainder = net % n for n winners; the winner at position 0 of the poster's index list gets share + remainder,
//   every other winner gets share. A winner with an agentId is paid to ownerOf(agentId), a human to the entrant.
// * A never-taken single bounty is never funded in the escrow (job stays Open), so cancelling or expiring it
//   refunds the poster from the adapter's own balance. Contests are funded at creation; cancelling or expiring one
//   without entries rejects the escrow job (Rejected).
// * claimArbitratorTimeout (single) pays no fee and splits the reward 50/50, remainder to the worker, and writes
//   disputeRulingHash = "timeout:50-50-split", which is how it is told apart from a normal Completed payout.
// * reconcileExpiredEscrow (escrow job Expired) pays no fee: unsubmitted -> poster refund, disputed -> default or
//   50/50 split, rejected -> poster refund, otherwise the worker gets the full reward.
//
// What storage cannot tell (documented limits, none of them affects the totals except where noted):
// * The order in which a poster listed the winners is not stored, so the contest remainder (at most n - 1 base
//   units of USDC) is attributed to the lowest-indexed awarded entry. Per-winner amounts can differ from the chain
//   by that remainder only when the poster listed the winners out of index order.
// * A contest settled by claimContestArbitratorTimeout (poster half, challengers half, no fee) leaves the same
//   storage as one settled by resolveContestDispute, so it is reported as a normal fee-charged award.
// * A never-taken bounty closed by its poster and one closed after its deadline both read as "cancelled".
// * There is no settlement timestamp without event logs: recently settled jobs are ordered by job id.

import { parseAbi } from "viem";

export const USDC_DECIMALS = 6;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Mirrors the adapter's immutable feeBps (1%). The route reads the real value and passes it in. */
export const DEFAULT_FEE_BPS = 100n;
export const BPS_DENOMINATOR = 10_000n;
/** disputeRulingHash written by BountyAdapterV48.claimArbitratorTimeout. */
export const ARBITRATOR_TIMEOUT_RULING = "timeout:50-50-split";

/** The one escrow read the stats need: AgenticCommerce.getJob(jobId).status. */
export const NAD_ESCROW_ABI = parseAbi([
  "function getJob(uint256) view returns((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))",
]);
/** ERC-8004 identity registry owner lookup, used to credit an agent's earnings to its owner wallet. */
export const NAD_REGISTRY_ABI = parseAbi(["function ownerOf(uint256) view returns (address)"]);

/** AgenticCommerce.JobStatus, in declaration order. */
export const ESCROW_STATUS = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 } as const;

// ─── Input shapes (structurally compatible with the viem-decoded contract reads) ──────────────────────────────

/** The subset of BountyAdapterV48.getBountyMeta that the stats read. */
export type NadStatsMeta = {
  jobId: bigint;
  poster: string;
  reward: bigint;
  deadline: bigint;
  agentId: bigint;
  assignedProvider: string;
  submittedResultHash: string;
  isTaken: boolean;
  rejectedAt: bigint;
  inDispute: boolean;
  resolved: boolean;
  disputeRaisedAt: bigint;
  disputeResponseHash: string;
  disputeRulingHash: string;
  disputeByWorker: boolean;
  contest: boolean;
  maxEntries: number;
};

/** The subset of a ContestEntry that the stats read. */
export type NadStatsEntry = { agentId: bigint; entrant: string; awarded: boolean };

export type NadJobSnapshot = {
  meta: NadStatsMeta;
  /** AgenticCommerce getJob(jobId).status. */
  escrowStatus: number;
  /** getContestEntries(jobId) for a contest; empty for a single-taker bounty. */
  entries: readonly NadStatsEntry[];
};

export type NadStatsContext = {
  /** Timestamp of the block the reads were pinned to, in seconds. */
  nowSec: bigint;
  /** The adapter's feeBps; defaults to 100. */
  feeBps?: bigint;
  /** Current ERC-8004 owner of an agent id, or null / undefined when the registry could not answer. */
  ownerOf?: (agentId: bigint) => string | null | undefined;
};

// ─── Money helpers ────────────────────────────────────────────────────────────────────────────────────────────

/** 1000000n -> "1", 2970000n -> "2.97". Same output as viem's formatUnits(units, 6). */
export function formatUsdcUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Protocol fee on a payout: reward * feeBps / 10_000, rounded down like the contract. */
export function nadFee(reward: bigint, feeBps: bigint = DEFAULT_FEE_BPS): bigint {
  return (reward * feeBps) / BPS_DENOMINATOR;
}

/** What a single-taker worker receives on approval: reward minus the fee. */
export function singleNet(reward: bigint, feeBps: bigint = DEFAULT_FEE_BPS): bigint {
  return reward - nadFee(reward, feeBps);
}

/** What a contest pays out in total: reward minus the fee, before it is split between the winners. */
export function contestNet(reward: bigint, feeBps: bigint = DEFAULT_FEE_BPS): bigint {
  return reward - nadFee(reward, feeBps);
}

/** _settleContest: an even split, the remainder (net % n) goes to the first winner. */
export function splitContestNet(net: bigint, winners: number): bigint[] {
  if (!Number.isInteger(winners) || winners < 1) return [];
  const n = BigInt(winners);
  const share = net / n;
  const remainder = net % n;
  return Array.from({ length: winners }, (_, i) => (i === 0 ? share + remainder : share));
}

// ─── Per-job classification ───────────────────────────────────────────────────────────────────────────────────

export type NadOutcome =
  | "open" // accepting a taker (single) or entries (contest)
  | "in_progress" // taken, submitted, under review, rejected or disputed
  | "paid" // a worker was credited the reward (minus the protocol fee where the contract charges it)
  | "split" // arbitrator-timeout or expired-escrow 50/50 split: the worker got part, no fee
  | "refunded" // the poster got the reward back after work or entries existed
  | "cancelled" // closed before any work: the poster got the reward back
  | "expired" // the deadline passed with no accepted work (refunded, or waiting to be)
  | "unclassified"; // storage and escrow status disagree; never guessed

export type NadPayout = {
  /** Wallet that was credited: the identity owner for an agent, the working wallet for a human. */
  owner: string;
  /** ERC-8004 agent id, 0 for a human wallet. */
  agentId: bigint;
  amount: bigint;
};

export type NadJobResult = {
  jobId: bigint;
  kind: "single" | "contest";
  outcome: NadOutcome;
  poster: string;
  reward: bigint;
  /** Protocol fee the contract charged on this job (0 for refunds, splits and escrow-expiry payouts). */
  fee: bigint;
  /** Total credited to workers (the sum of payouts). */
  netPaid: bigint;
  payouts: NadPayout[];
};

type WorkerSplit = { outcome: NadOutcome; fee: bigint; worker: bigint };

function result(meta: NadStatsMeta, outcome: NadOutcome, fee = 0n, payouts: NadPayout[] = []): NadJobResult {
  return {
    jobId: meta.jobId,
    kind: meta.contest ? "contest" : "single",
    outcome,
    poster: meta.poster,
    reward: meta.reward,
    fee,
    netPaid: payouts.reduce((sum, p) => sum + p.amount, 0n),
    payouts,
  };
}

function resolveOwner(ctx: NadStatsContext, agentId: bigint, wallet: string): string {
  if (agentId === 0n) return wallet;
  return ctx.ownerOf?.(agentId) || ZERO_ADDRESS;
}

/** How a resolved single-taker bounty ended, and how much of the reward the worker received. */
function singleResolved(meta: NadStatsMeta, escrowStatus: number, feeBps: bigint): WorkerSplit {
  const none = (outcome: NadOutcome): WorkerSplit => ({ outcome, fee: 0n, worker: 0n });
  const submitted = meta.submittedResultHash !== "";
  switch (escrowStatus) {
    case ESCROW_STATUS.Completed: {
      if (meta.disputeRulingHash === ARBITRATOR_TIMEOUT_RULING) {
        return { outcome: "split", fee: 0n, worker: meta.reward - meta.reward / 2n };
      }
      const fee = nadFee(meta.reward, feeBps);
      return { outcome: "paid", fee, worker: meta.reward - fee };
    }
    case ESCROW_STATUS.Rejected:
      // A funded escrow is only rejected by finalizeRejection, a dispute for the poster, or expireBounty on a
      // taken bounty that never submitted. A rejected escrow on a never-taken bounty cannot happen.
      if (!meta.isTaken) return none("unclassified");
      return none(submitted ? "refunded" : "expired");
    case ESCROW_STATUS.Expired: {
      // reconcileExpiredEscrow, mirrored branch by branch (it clears inDispute, disputeRaisedAt survives).
      if (!submitted) return none("expired");
      if (meta.disputeRaisedAt > 0n) {
        if (meta.disputeResponseHash !== "")
          return { outcome: "split", fee: 0n, worker: meta.reward - meta.reward / 2n };
        return meta.disputeByWorker ? { outcome: "paid", fee: 0n, worker: meta.reward } : none("expired");
      }
      if (meta.rejectedAt > 0n) return none("expired");
      return { outcome: "paid", fee: 0n, worker: meta.reward };
    }
    case ESCROW_STATUS.Open:
      // Never funded: cancelBounty / expireBounty on a bounty nobody took.
      return none(meta.isTaken ? "unclassified" : "cancelled");
    default:
      return none("unclassified");
  }
}

/** How a resolved contest ended. `awarded` is the number of awarded entries. */
function contestResolved(
  meta: NadStatsMeta,
  escrowStatus: number,
  entryCount: number,
  awarded: number,
  feeBps: bigint,
): { outcome: NadOutcome; fee: bigint; net: bigint } {
  const refund = (outcome: NadOutcome) => ({ outcome, fee: 0n, net: 0n });
  switch (escrowStatus) {
    case ESCROW_STATUS.Completed: {
      if (awarded === 0) return refund("unclassified");
      const fee = nadFee(meta.reward, feeBps);
      return { outcome: "paid", fee, net: meta.reward - fee };
    }
    case ESCROW_STATUS.Rejected:
      if (awarded > 0) return refund("unclassified");
      return refund(entryCount === 0 ? "cancelled" : "refunded");
    case ESCROW_STATUS.Expired:
      // reconcileExpiredEscrow -> _settleContest(escrowRecovery): no fee, the whole reward is split.
      return awarded > 0 ? { outcome: "paid", fee: 0n, net: meta.reward } : refund("expired");
    default:
      return refund("unclassified");
  }
}

/** Where a job that is not resolved yet stands. */
function unresolvedOutcome({ meta, escrowStatus, entries }: NadJobSnapshot, ctx: NadStatsContext): NadOutcome {
  // The escrow gave up on the job (deadline + 90 days) before anyone settled it.
  if (escrowStatus === ESCROW_STATUS.Expired) return "expired";
  const underReview = meta.inDispute || meta.rejectedAt > 0n;
  if (meta.contest) {
    if (underReview) return "in_progress";
    // A contest closes at its deadline (block.timestamp >= deadline) or when its last seat is taken.
    if (entries.length === 0) return ctx.nowSec < meta.deadline ? "open" : "expired";
    return ctx.nowSec < meta.deadline && entries.length < meta.maxEntries ? "open" : "in_progress";
  }
  if (underReview || meta.submittedResultHash !== "") return "in_progress";
  // takeBounty and submitWork both need block.timestamp <= deadline; expireBounty needs it to be past.
  const beforeDeadline = ctx.nowSec <= meta.deadline;
  if (meta.isTaken) return beforeDeadline ? "in_progress" : "expired";
  return beforeDeadline ? "open" : "expired";
}

/** Classifies one job and works out who was credited what. */
export function classifyNadJob(job: NadJobSnapshot, ctx: NadStatsContext): NadJobResult {
  const { meta, escrowStatus, entries } = job;
  const feeBps = ctx.feeBps ?? DEFAULT_FEE_BPS;

  if (!meta.resolved) return result(meta, unresolvedOutcome(job, ctx));

  if (meta.contest) {
    const awardedIdx = entries.flatMap((e, i) => (e.awarded ? [i] : []));
    const end = contestResolved(meta, escrowStatus, entries.length, awardedIdx.length, feeBps);
    if (end.outcome !== "paid") return result(meta, end.outcome);
    const amounts = splitContestNet(end.net, awardedIdx.length);
    const payouts = awardedIdx.map((index, i): NadPayout => {
      const entry = entries[index];
      return { owner: resolveOwner(ctx, entry.agentId, entry.entrant), agentId: entry.agentId, amount: amounts[i] };
    });
    return result(meta, "paid", end.fee, payouts);
  }

  const end = singleResolved(meta, escrowStatus, feeBps);
  if (end.worker === 0n) return result(meta, end.outcome);
  return result(meta, end.outcome, end.fee, [
    { owner: resolveOwner(ctx, meta.agentId, meta.assignedProvider), agentId: meta.agentId, amount: end.worker },
  ]);
}

/** Short label for a status chip or a link-preview card. */
export function nadOutcomeLabel(outcome: NadOutcome): string {
  switch (outcome) {
    case "open":
      return "Open";
    case "in_progress":
      return "In progress";
    case "paid":
      return "Paid";
    case "split":
      return "Settled";
    case "refunded":
      return "Refunded";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
    default:
      return "Unknown";
  }
}

// ─── Aggregation ──────────────────────────────────────────────────────────────────────────────────────────────

export type NadStatsSummary = {
  posted: number;
  open: number;
  inProgress: number;
  /** Jobs where a worker was credited (outcome paid or split). */
  settledPaid: number;
  /** Jobs whose reward went back to the poster: refunded or cancelled. */
  refunded: number;
  /** Jobs that ended, or are waiting to end, at their deadline with no accepted work. */
  expired: number;
  /** Jobs whose storage and escrow status disagree (normally 0). */
  unclassified: number;
  postedUsdc: string;
  openUsdc: string;
  /** Total credited to workers, net of the protocol fee. */
  paidOutUsdc: string;
  feesUsdc: string;
  uniquePosters: number;
  /** Distinct identities (an ERC-8004 agent id, or a human wallet) that were credited at least once. */
  uniquePaidIdentities: number;
};

export type NadLeaderboardRow = {
  /** Current identity owner for an agent, the working wallet for a human; the zero address if unresolved. */
  owner: string;
  /** ERC-8004 agent id, 0 for a human wallet. */
  agentId: number;
  paidJobs: number;
  usdcEarned: string;
};

export type NadSettledRow = {
  jobId: number;
  kind: "single" | "contest";
  outcome: "paid" | "split";
  reward: string;
  netPaid: string;
  fee: string;
  /** First credited wallet (the only one except in a multi-winner contest). */
  ownerPaid: string;
  /** Agent id of the first credited identity, 0 for a human. */
  agentId: number;
  payouts: { owner: string; agentId: number; usdc: string }[];
  /** Always true: without event logs there is no settlement time, so rows are ordered by job id. */
  resolvedAtUnknown: true;
};

export type NadStatsReport = {
  stats: NadStatsSummary;
  leaderboard: NadLeaderboardRow[];
  recentlySettled: NadSettledRow[];
};

export type NadReportOptions = { recentLimit?: number; leaderboardLimit?: number };

const identityKey = (p: NadPayout) => (p.agentId !== 0n ? `agent:${p.agentId}` : `human:${p.owner.toLowerCase()}`);

/** Builds the whole public stats object from raw job snapshots. Jobs without a poster are ignored. */
export function buildNadStatsReport(
  jobs: readonly NadJobSnapshot[],
  ctx: NadStatsContext,
  options: NadReportOptions = {},
): NadStatsReport {
  const { recentLimit = 20, leaderboardLimit = 100 } = options;
  const results = jobs
    .filter((j) => j.meta.poster && j.meta.poster !== ZERO_ADDRESS)
    .map((j) => classifyNadJob(j, ctx));

  const count = { open: 0, in_progress: 0, settled: 0, refunded: 0, expired: 0, unclassified: 0 };
  let postedUnits = 0n,
    openUnits = 0n,
    paidOutUnits = 0n,
    feeUnits = 0n;
  const posters = new Set<string>();
  const board = new Map<string, { row: NadPayout; paidJobs: number; earned: bigint }>();

  for (const r of results) {
    posters.add(r.poster.toLowerCase());
    postedUnits += r.reward;
    feeUnits += r.fee;
    switch (r.outcome) {
      case "open":
        count.open++;
        openUnits += r.reward;
        break;
      case "in_progress":
        count.in_progress++;
        break;
      case "paid":
      case "split":
        count.settled++;
        break;
      case "refunded":
      case "cancelled":
        count.refunded++;
        break;
      case "expired":
        count.expired++;
        break;
      default:
        count.unclassified++;
    }
    for (const p of r.payouts) {
      paidOutUnits += p.amount;
      const key = identityKey(p);
      const entry = board.get(key) ?? { row: p, paidJobs: 0, earned: 0n };
      entry.paidJobs++;
      entry.earned += p.amount;
      board.set(key, entry);
    }
  }

  const leaderboard = [...board.entries()]
    .sort(
      ([ka, a], [kb, b]) =>
        b.paidJobs - a.paidJobs || (b.earned > a.earned ? 1 : b.earned < a.earned ? -1 : 0) || (ka < kb ? -1 : 1),
    )
    .slice(0, leaderboardLimit)
    .map(
      ([, e]): NadLeaderboardRow => ({
        owner: e.row.owner,
        agentId: Number(e.row.agentId),
        paidJobs: e.paidJobs,
        usdcEarned: formatUsdcUnits(e.earned),
      }),
    );

  const recentlySettled = results
    .filter((r) => r.outcome === "paid" || r.outcome === "split")
    .sort((a, b) => (a.jobId === b.jobId ? 0 : a.jobId > b.jobId ? -1 : 1))
    .slice(0, recentLimit)
    .map(
      (r): NadSettledRow => ({
        jobId: Number(r.jobId),
        kind: r.kind,
        outcome: r.outcome as "paid" | "split",
        reward: formatUsdcUnits(r.reward),
        netPaid: formatUsdcUnits(r.netPaid),
        fee: formatUsdcUnits(r.fee),
        ownerPaid: r.payouts[0]?.owner ?? ZERO_ADDRESS,
        agentId: Number(r.payouts[0]?.agentId ?? 0n),
        payouts: r.payouts.map((p) => ({
          owner: p.owner,
          agentId: Number(p.agentId),
          usdc: formatUsdcUnits(p.amount),
        })),
        resolvedAtUnknown: true,
      }),
    );

  return {
    stats: {
      posted: results.length,
      open: count.open,
      inProgress: count.in_progress,
      settledPaid: count.settled,
      refunded: count.refunded,
      expired: count.expired,
      unclassified: count.unclassified,
      postedUsdc: formatUsdcUnits(postedUnits),
      openUsdc: formatUsdcUnits(openUnits),
      paidOutUsdc: formatUsdcUnits(paidOutUnits),
      feesUsdc: formatUsdcUnits(feeUnits),
      uniquePosters: posters.size,
      uniquePaidIdentities: board.size,
    },
    leaderboard,
    recentlySettled,
  };
}
