// Pure NadBounty view helpers. No React, no wagmi, no browser APIs: safe to import from node:test.
import type { ContractFunctionReturnType } from "viem";
import type { BOUNTY_ADAPTER_V48_ABI as ABI } from "./abi-v48";
import { secondsToDeadline } from "./format";
import { ARBITRATOR_TIMEOUT_RULING, ESCROW_STATUS } from "./nadStats";

export type Meta = ContractFunctionReturnType<typeof ABI, "view", "getBountyMeta">;
export type Entry = ContractFunctionReturnType<typeof ABI, "view", "getContestEntries">[number];
export type NadStatus = { kind: string; label: string };

export const CATEGORY_ICONS: Record<string, string> = {
  all: "✦",
  dev: "⌘",
  design: "◐",
  content: "✎",
  data: "▤",
  other: "◯",
};
export const KNOWN_CATS = new Set(["dev", "design", "content", "data", "other"]);

// Reputation gates offered by the post form. The labels are what people read; the keys of GATE_PARAMS are what the
// form stores. BountyAdapterV48._checkGate compares scoreSum against minAvgScore * paidJobs, so "80+ average" is exact.
export const GATES: Record<string, string> = {
  Anyone: "all",
  "Proven: 3+ paid jobs, 80+ average": "proven",
  "Top: 10+ paid jobs, 90+ average": "top",
};
export const GATE_PARAMS: Record<string, { minJobs: bigint; minAvgScore: number }> = {
  all: { minJobs: 0n, minAvgScore: 0 },
  proven: { minJobs: 3n, minAvgScore: 80 },
  top: { minJobs: 10n, minAvgScore: 90 },
};
export const GATE_HINT = "Counts scored paid jobs on Monad plus mirrored Base and Arc records.";

const article = (n: number) => (/^8/.test(String(n)) || n === 11 || n === 18 ? "an" : "a");

/** "Needs 3+ paid jobs and an 80+ average", or null when the bounty has no gate. */
export function gateRequirement(minJobs: bigint | number, minAvgScore: bigint | number): string | null {
  const jobs = BigInt(minJobs);
  const avg = Number(minAvgScore);
  if (jobs > 0n && avg > 0) return `Needs ${jobs}+ paid jobs and ${article(avg)} ${avg}+ average`;
  if (jobs > 0n) return `Needs ${jobs}+ paid jobs`;
  if (avg > 0) return `Needs ${article(avg)} ${avg}+ average`;
  return null;
}

export function nadTitleOf(raw: string): string {
  let text = raw;
  try {
    const j = JSON.parse(raw);
    // Pinned descriptions use "title"; the demo bounties were pinned as { name, description }.
    for (const key of ["title", "name"]) {
      const value = j?.[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 100);
    }
    if (typeof j?.description === "string") text = j.description;
  } catch {}
  const first =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const stripped = first
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .trim();
  return stripped.length > 100 ? `${stripped.slice(0, 100)}…` : stripped;
}

/**
 * Optional on-chain context. Everything is a view read the detail page already has; the board can pass nothing.
 * - escrowStatus: AgenticCommerce getJob(jobId).status (0 Open, 1 Funded, 2 Submitted, 3 Completed, 4 Rejected, 5 Expired)
 * - closedAt: adapter getContestState(jobId).closedAt (0 while a contest still takes entries)
 * - entryCount / anyAwarded: from getContestEntries
 * - nowSeconds: chain time, so the label and the buttons agree (defaults to the local clock)
 */
export type NadStatusCtx = {
  escrowStatus?: number;
  closedAt?: bigint;
  entryCount?: number;
  anyAwarded?: boolean;
  nowSeconds?: bigint;
};

const positive = (value: bigint | undefined) => value !== undefined && value > 0n;

/** How the escrow of a resolved single-taker bounty ended when AgenticCommerce had already expired it (reconcileExpiredEscrow). */
export type ReconcileShare = "worker" | "split" | "poster";
/**
 * Mirrors the branches of BountyAdapterV48.reconcileExpiredEscrow for a single-taker bounty. inDispute is cleared by
 * the call, but disputeRaisedAt survives, so it is used to know the job had been disputed.
 */
export function reconcileShare(
  m: Pick<Meta, "submittedResultHash" | "disputeRaisedAt" | "disputeResponseHash" | "disputeByWorker" | "rejectedAt">,
): ReconcileShare {
  if (!m.submittedResultHash) return "poster";
  if (positive(m.disputeRaisedAt)) {
    if (m.disputeResponseHash) return "split";
    return m.disputeByWorker ? "worker" : "poster";
  }
  if (positive(m.rejectedAt)) return "poster";
  return "worker";
}

export type Resolution = "paid" | "split" | "refunded" | "expired-refunded" | "settled";
/** The few meta fields that decide how a resolved bounty ended. */
export type ResolutionMeta = Pick<Meta, "contest" | "disputeRulingHash"> & Parameters<typeof reconcileShare>[0];

/**
 * What a resolved bounty ended as. Terminal paths in BountyAdapterV48 (resolved = true):
 * - approveBounty, autoApprove, resolveDispute(pay worker), claimDefaultRuling(worker): escrow Completed (3), paid, 1% fee.
 * - claimArbitratorTimeout: escrow Completed (3) but split 50/50 with no fee (disputeRulingHash "timeout:50-50-split").
 * - finalizeRejection, resolveDispute(pay poster), claimDefaultRuling(poster), expireBounty on a taken bounty,
 *   cancelBounty / expireBounty on a contest without entries, finalizeContestRejection: escrow Rejected (4), refunded.
 * - cancelBounty / expireBounty on a bounty nobody took: the escrow job was never funded, so it stays Open (0); the
 *   poster is refunded from the adapter's own balance.
 * - reconcileExpiredEscrow: escrow Expired (5); who got what depends on how far the job had got.
 * - Contest awards (pickContestWinners, settleContestSilence, acceptContestChallengers, claimContestDefault,
 *   resolveContestDispute with winners, claimContestArbitratorTimeout): escrow Completed (3) and awarded entries.
 * Without an escrow status the answer stays the legacy "settled".
 */
export function resolutionOf(m: ResolutionMeta, ctx: NadStatusCtx = {}): Resolution {
  const escrow = ctx.escrowStatus;
  const awarded = ctx.anyAwarded === true;
  if (escrow === ESCROW_STATUS.Expired) {
    if (m.contest) return awarded ? "paid" : "expired-refunded";
    const share = reconcileShare(m);
    return share === "poster" ? "expired-refunded" : share === "split" ? "split" : "paid";
  }
  if (escrow === ESCROW_STATUS.Completed) {
    return !m.contest && m.disputeRulingHash === ARBITRATOR_TIMEOUT_RULING ? "split" : "paid";
  }
  if (awarded) return "paid";
  if (escrow === ESCROW_STATUS.Open || escrow === ESCROW_STATUS.Rejected) return "refunded";
  if (m.contest && ctx.anyAwarded === false) return "refunded";
  return "settled";
}

const RESOLVED_STATUS: Record<Resolution, NadStatus> = {
  paid: { kind: "paid", label: "Paid" },
  split: { kind: "paid", label: "Split 50/50" },
  refunded: { kind: "expired", label: "Refunded" },
  "expired-refunded": { kind: "expired", label: "Expired and refunded" },
  settled: { kind: "paid", label: "Settled" },
};

/**
 * The status badge. Priority, highest first:
 * 1. in dispute (also when a resolved flag is still set, as before)
 * 2. resolved: Paid, Split 50/50, Refunded, Expired and refunded (or the legacy Settled without an escrow status)
 * 3. rejected: the poster rejected and the challenge window is open
 * 4. contest with context: closed with entries -> In review, closed without entries -> Expired, else Open
 * 5. single taker: Submitted, In progress, Expired, Open
 * A call without ctx behaves like the original one-argument version, except that a pending rejection now reads
 * "Rejected" instead of "Submitted" (or "Open" for a contest).
 */
export function nadStatus(m: Meta, ctx: NadStatusCtx = {}): NadStatus {
  if (m.inDispute) return { kind: "in-review", label: "In dispute" };
  if (m.resolved) return RESOLVED_STATUS[resolutionOf(m, ctx)];
  if (positive(m.rejectedAt)) return { kind: "submitted", label: "Rejected" };
  if (m.contest && ctx.closedAt !== undefined) {
    // BountyAdapterV48.contestClosedAt: closed when stored (full or picked early) or from the deadline on.
    const closed = ctx.closedAt > 0n || (ctx.nowSeconds !== undefined && ctx.nowSeconds >= m.deadline);
    if (!closed) return { kind: "open", label: "Open" };
    return ctx.entryCount === 0 ? { kind: "expired", label: "Expired" } : { kind: "in-review", label: "In review" };
  }
  const expired = ctx.nowSeconds !== undefined ? ctx.nowSeconds > m.deadline : secondsToDeadline(m.deadline).expired;
  if (m.submittedResultHash) return { kind: "submitted", label: "Submitted" };
  if (m.isTaken) return { kind: "in-review", label: "In progress" };
  if (expired) return { kind: "expired", label: "Expired" };
  return { kind: "open", label: "Open" };
}
