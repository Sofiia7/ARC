// Pure NadBounty action rules for the detail page: chain-time labels, plain-sentence reasons a button is disabled,
// readable names for the permissionless settlements, and the label of the shared text box. No React, no wagmi, no
// browser APIs: safe to import from node:test. The adapter still enforces every rule; these checks only explain a
// refusal before the wallet opens, and each one mirrors the require() it names in BountyAdapterV48.sol.
import type { NadSettlement } from "./nadKeeper";
import { workerBondFor } from "./nadMoney";
import { gateRequirement, type Meta } from "./nadStatus";
import { formatUsdcUnits } from "./nadStats";
import {
  APPROVAL_TIMEOUT,
  ARBITRATOR_TIMEOUT,
  DISPUTE_RESPONSE_WINDOW,
  HOUR,
  REJECTION_CHALLENGE_WINDOW,
} from "./nadTimeline";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** BountyAdapterV48.MIN_BOND_TAKE_WINDOW: a bond bounty cannot be taken with less than this left. */
export const MIN_BOND_TAKE_WINDOW = 12n * HOUR;

// ───────── chain clock ─────────

/** Chain time estimated from the last block read: the block's timestamp plus the real seconds since it was fetched. */
export function estimateChainNow(blockTimestamp: bigint, fetchedAtMs: number, nowMs: number): bigint {
  return blockTimestamp + BigInt(Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000)));
}

/** BountyAdapterV48.contestClosedAt: the stored closure, else the deadline once it has been reached. */
export function contestClosedAtView(storedClosedAt: bigint, deadline: bigint, now: bigint): bigint {
  if (storedClosedAt > 0n) return storedClosedAt;
  return now >= deadline ? deadline : 0n;
}

/** "2d 4h", "5h 10m", "12m", "under a minute". */
export function timeLeftText(deadline: bigint, now: bigint): string {
  const diff = deadline - now;
  if (diff < 60n) return "under a minute";
  const days = diff / 86400n;
  const hours = (diff % 86400n) / 3600n;
  const mins = (diff % 3600n) / 60n;
  if (days > 0n) return `${days}d ${hours}h`;
  if (hours > 0n) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export type DeadlineInfo = { passed: boolean; label: string };
/**
 * One verdict for the label and the buttons. Single taker: takeBounty and submitWork need block.timestamp <= deadline,
 * so the deadline has passed once now > deadline. Contest: closed from block.timestamp >= deadline (contestClosedAt).
 */
export function deadlineInfo(
  m: Pick<Meta, "contest" | "deadline" | "resolved">,
  now: bigint,
  storedClosedAt: bigint = 0n,
): DeadlineInfo {
  if (m.resolved) return { passed: true, label: "Settled" };
  if (m.contest) {
    const closed = contestClosedAtView(storedClosedAt, m.deadline, now);
    if (closed > 0n) return { passed: true, label: "Entries closed" };
  } else if (now > m.deadline) {
    return { passed: true, label: "Deadline passed" };
  }
  return { passed: false, label: `${timeLeftText(m.deadline, now)} left` };
}

// ───────── settlement names ─────────

export type SettlementCtx = { contest: boolean; isTaken: boolean; disputeByWorker: boolean };
export type SettlementText = { button: string; description: string };

/** Sentences for every permissionless settlement in NAD_SETTLEMENTS (lib/nadKeeper.ts). */
export function settlementText(settlement: NadSettlement, ctx: SettlementCtx): SettlementText {
  switch (settlement) {
    case "autoApprove":
      return {
        button: "Release payment to the worker (review window passed)",
        description:
          "The poster did not approve or reject within 14 days of the submission. Anyone can now pay the worker (minus the 1% fee). The worker is scored 80.",
      };
    case "expireBounty":
      if (ctx.contest)
        return {
          button: "Refund the poster (no entries before the deadline)",
          description:
            "The deadline passed and nobody entered. Anyone can now return the reward to the poster. No fee.",
        };
      return {
        button: "Refund the poster (deadline passed)",
        description: ctx.isTaken
          ? "The worker took the bounty but did not submit in time. Anyone can now refund the poster; a worker deposit, if there was one, goes to the poster. No fee."
          : "Nobody took this bounty before the deadline. Anyone can now return the reward to the poster. No fee.",
      };
    case "finalizeRejection":
      return {
        button: "Finalize rejection and refund the poster",
        description:
          "The worker did not challenge the rejection within 48 hours. Anyone can now refund the poster. No fee.",
      };
    case "claimDefaultRuling":
      return ctx.disputeByWorker
        ? {
            button: "Apply default ruling (poster did not respond)",
            description:
              "The poster did not reply within 48 hours, so the worker wins by default. Anyone can now pay the worker (minus the 1% fee).",
          }
        : {
            button: "Apply default ruling (worker did not respond)",
            description:
              "The worker did not reply within 48 hours, so the poster wins by default. Anyone can now refund the poster. No fee.",
          };
    case "claimArbitratorTimeout":
      return {
        button: "Arbitrator timed out: split 50/50",
        description:
          "Both sides replied but the arbitrator did not rule within 30 days. Anyone can now split the reward 50/50 between the poster and the worker. No fee.",
      };
    case "reconcileExpiredEscrow":
      return {
        button: "Recover the expired escrow (90 days passed)",
        description:
          "Nobody settled this job within 90 days of its deadline, so the escrow expired. Anyone can now recover the funds and apply the outcome that would have applied. No fee.",
      };
    case "settleContestSilence":
      return {
        button: "Split the payment among all entries (review window passed)",
        description:
          "The poster did not decide within 14 days of the contest closing. Anyone can now split the reward (minus the 1% fee) evenly among all entries. No reputation credit is recorded.",
      };
    case "finalizeContestRejection":
      return {
        button: "Finalize rejection and refund the poster",
        description: "Nobody challenged the rejection within 48 hours. Anyone can now refund the poster. No fee.",
      };
    case "claimContestDefault":
      return {
        button: "Apply default ruling (poster did not respond)",
        description:
          "A challenge went unanswered for 48 hours. Anyone can now pay the challengers by default (minus the 1% fee, split evenly).",
      };
    case "claimContestArbitratorTimeout":
      return {
        button: "Arbitrator timed out: split 50/50 with the challengers",
        description:
          "Every challenge was answered but the arbitrator did not rule within 30 days. Anyone can now split the reward: half back to the poster, half shared by the challengers. No fee.",
      };
  }
}

// ───────── the shared text box ─────────

export type TextIntentInput = {
  poster: boolean;
  contest: boolean;
  inDispute: boolean;
  rejectedAt: bigint;
  disputeByWorker: boolean;
};
export type TextIntent = { label: string; hint: string };

/** What the one text box is for, depending on who is looking and what stage the bounty is in. */
export function textIntent(i: TextIntentInput): TextIntent {
  if (i.poster) {
    return i.inDispute
      ? {
          label: "Your response",
          hint: "Public, so the arbitrator can read it. It answers every open challenge.",
        }
      : {
          label: "Reason for rejection",
          hint: "Public, so the worker and the arbitrator can read it. You only need it to reject.",
        };
  }
  if (i.rejectedAt > 0n) {
    return { label: "Evidence for your challenge", hint: "Public, so the arbitrator can read it." };
  }
  if (i.inDispute && !i.contest && !i.disputeByWorker) {
    return { label: "Your response", hint: "Public, so the arbitrator can read it." };
  }
  return {
    label: "Your result",
    hint: i.contest
      ? "Encrypted in your browser before upload: only the poster can read it."
      : "Stored on IPFS as plain text: anyone with the link can read it, including the poster.",
  };
}

// ───────── score ─────────

export const DEFAULT_SCORE = 90;
export function parseScore(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim();
  if (!/^\d{1,3}$/.test(text) || Number(text) > 100) {
    return { ok: false, error: "Enter a whole number score from 0 to 100." };
  }
  return { ok: true, value: Number(text) };
}

// ───────── why a button is disabled ─────────

/** BountyAdapterV48._checkGate: fails below minJobs, with no jobs while an average is required, or below the average. */
export function gateFails(minJobs: bigint, minAvgScore: number, jobs: bigint, scoreSum: bigint): boolean {
  if (minJobs === 0n && minAvgScore === 0) return false;
  return jobs < minJobs || (jobs === 0n && minAvgScore !== 0) || scoreSum < BigInt(minAvgScore) * jobs;
}

export type WorkerMeta = Pick<
  Meta,
  | "contest"
  | "deadline"
  | "resolved"
  | "isTaken"
  | "agentOnly"
  | "humanOnly"
  | "whitelistedProvider"
  | "requireWorkerBond"
  | "reward"
  | "maxEntries"
  | "minJobs"
  | "minAvgScore"
>;
export type WorkerCheck = {
  mode: "enter" | "take";
  meta: WorkerMeta;
  /** Chain time. */
  now: bigint;
  paused: boolean;
  /** getContestState.closedAt as last read (0 while open). */
  closedAt: bigint;
  entries: readonly { agentId: bigint; entrant: string }[];
  /** The identity being used: agentId 0 is the connected wallet as a human. */
  identity: { agentId: bigint; wallet: string; controlled: boolean; owner?: string | null };
  /** How many agents the wallet can act for (changes the agent-only advice). */
  agentCount: number;
  /** Identity totals from getIdentityReputation, when read. */
  gate?: { jobs: bigint; sum: bigint } | null;
  /** The wallet's USDC balance, when read (only used for the refundable deposit). */
  usdcBalance?: bigint | null;
};

const plural = (n: bigint | number, word: string) => `${n} ${word}${BigInt(n) === 1n ? "" : "s"}`;

export function averageText(jobs: bigint, sum: bigint): string {
  if (jobs === 0n) return "no average yet";
  const hundredths = (sum * 100n) / jobs;
  return `an average of ${Number(hundredths) / 100}`;
}

/** The first reason this identity cannot enter the contest or take the bounty, or null. Order follows the contract. */
export function workerBlocker(i: WorkerCheck): string | null {
  const { meta, now, identity } = i;
  if (i.paused) {
    return i.mode === "enter"
      ? "Entries are paused right now. Existing settlements still work."
      : "Taking bounties is paused right now. Existing settlements still work.";
  }
  if (meta.resolved) return "This bounty is already settled.";
  if (i.mode === "enter") {
    if (i.entries.length >= Number(meta.maxEntries)) {
      return `This contest is full: all ${Number(meta.maxEntries)} entry slots are taken.`;
    }
    if (now >= meta.deadline) return "The deadline has passed, so this contest no longer takes entries.";
    if (i.closedAt > 0n) return "This contest has closed and no longer takes entries.";
  } else {
    if (meta.isTaken) return "Someone already took this bounty.";
    if (now > meta.deadline) return "The deadline has passed.";
    if (meta.requireWorkerBond && now + MIN_BOND_TAKE_WINDOW > meta.deadline) {
      return "This bounty needs a deposit and is too close to its deadline: at least 12 hours must remain to take it.";
    }
  }
  if (meta.agentOnly && identity.agentId === 0n) {
    return i.agentCount > 0
      ? "This bounty is for agents only. Choose one of your agents under Acting as."
      : "This bounty is for agents only. Register an agent or enter an agent ID you control.";
  }
  if (meta.humanOnly && identity.agentId !== 0n) {
    return "This bounty is for humans only. Switch Acting as to Me (wallet).";
  }
  if (identity.agentId !== 0n && !identity.controlled) {
    return `Your wallet does not control agent #${identity.agentId}.`;
  }
  // For an agent whose owner was not read (identity.owner undefined) the contract decides: the owner may be reserved.
  if (meta.whitelistedProvider !== ZERO_ADDRESS && !(identity.agentId !== 0n && identity.owner === undefined)) {
    const allowed = meta.whitelistedProvider.toLowerCase();
    const ok =
      allowed === identity.wallet.toLowerCase() || (!!identity.owner && allowed === identity.owner.toLowerCase());
    if (!ok) return "This bounty is reserved for one specific wallet.";
  }
  if (i.mode === "enter") {
    const already = i.entries.some((e) =>
      identity.agentId !== 0n
        ? e.agentId === identity.agentId
        : e.agentId === 0n && e.entrant.toLowerCase() === identity.wallet.toLowerCase(),
    );
    if (already) {
      return "You already entered this contest as this identity. Replace your sealed entry instead (possible until the contest closes).";
    }
  }
  const need = gateRequirement(meta.minJobs, meta.minAvgScore);
  if (need && i.gate && gateFails(meta.minJobs, Number(meta.minAvgScore), i.gate.jobs, i.gate.sum)) {
    return `${need}. This identity has ${plural(i.gate.jobs, "paid job")} and ${averageText(i.gate.jobs, i.gate.sum)}.`;
  }
  if (i.mode === "take" && meta.requireWorkerBond && i.usdcBalance !== undefined && i.usdcBalance !== null) {
    const bond = workerBondFor(meta.reward);
    if (i.usdcBalance < bond) {
      return `You need ${formatUsdcUnits(bond)} USDC for the refundable deposit; your wallet has ${formatUsdcUnits(i.usdcBalance)} USDC.`;
    }
  }
  return null;
}

type PosterMeta = Pick<
  Meta,
  | "contest"
  | "resolved"
  | "isTaken"
  | "inDispute"
  | "rejectedAt"
  | "submittedResultHash"
  | "submittedAt"
  | "disputeByWorker"
  | "disputeRaisedAt"
  | "disputeResponseHash"
  | "winners"
>;

const SETTLED = "This bounty is already settled.";

/** approveBounty: needs a submission, no dispute, no pending rejection. */
export function approveBlocker(m: PosterMeta): string | null {
  if (m.resolved) return SETTLED;
  if (!m.submittedResultHash) return "Nothing to approve yet: the worker has not submitted work.";
  if (m.inDispute) return "This job is in a dispute. Respond to it or wait for the ruling.";
  if (m.rejectedAt > 0n)
    return "You rejected this work. The worker has 48 hours to challenge, then the reward is refunded.";
  return null;
}

/** rejectBounty: as approve, and only within the 14-day review window. */
export function rejectBlocker(m: PosterMeta, now: bigint): string | null {
  const base = approveBlocker(m);
  if (base) return base;
  if (now > m.submittedAt + APPROVAL_TIMEOUT) {
    return "The 14-day review window has ended. Anyone can now release payment to the worker.";
  }
  return null;
}

/** cancelBounty: only before anyone took part. */
export function cancelBlocker(m: PosterMeta, entryCount: number): string | null {
  if (m.resolved) return SETTLED;
  if (m.isTaken) return "Someone already took this bounty, so it can no longer be cancelled.";
  if (m.contest && entryCount > 0) return "This contest already has entries, so it can no longer be cancelled.";
  return null;
}

/** pickContestWinners / acceptContestChallengers. `method` comes from contestPaymentMethod. */
export function payContestBlocker(m: PosterMeta, method: string | null, selectedCount: number): string | null {
  if (m.resolved) return SETTLED;
  if (!method) {
    return m.rejectedAt > 0n
      ? "You rejected all entries. Only entries that challenge the rejection can still be paid."
      : "The 14-day review window has ended. Anyone can now split the payment among all entries.";
  }
  if (selectedCount === 0) return "Select at least one winner below.";
  if (selectedCount > Number(m.winners)) {
    return `This contest pays at most ${plural(Number(m.winners), "winner")}. Deselect an entry.`;
  }
  return null;
}

/** rejectAllContestEntries: after the contest closes, within the review window, once. */
export function rejectAllBlocker(m: PosterMeta, entryCount: number, closedAt: bigint, now: bigint): string | null {
  if (m.resolved) return SETTLED;
  if (m.rejectedAt > 0n) return "You already rejected all entries.";
  if (entryCount === 0) return "There are no entries to reject.";
  if (closedAt === 0n)
    return "You can reject all entries once the contest closes (at the deadline or when every slot is filled).";
  if (now > closedAt + APPROVAL_TIMEOUT) return "The 14-day review window has ended.";
  return null;
}

/** respondToDispute (single) / respondToContestChallenges (contest), by the poster. */
export function respondBlocker(
  m: PosterMeta,
  now: bigint,
  challenges: readonly { challengedAt: bigint; respondedAt: bigint }[],
): string | null {
  if (m.resolved) return SETTLED;
  if (m.contest) {
    const open = challenges.filter((c) => c.challengedAt > 0n && c.respondedAt === 0n);
    if (open.length === 0) return "You already answered every challenge.";
    if (open.some((c) => now > c.challengedAt + DISPUTE_RESPONSE_WINDOW)) {
      return "The 48-hour window to answer a challenge has ended. Anyone can now pay the challengers by default.";
    }
    if (now > m.disputeRaisedAt + ARBITRATOR_TIMEOUT) return "The arbitrator window has ended.";
    return null;
  }
  if (!m.disputeByWorker) return "You opened this dispute, so the worker has to reply.";
  if (m.disputeResponseHash) return "You already replied to this dispute.";
  if (now > m.disputeRaisedAt + DISPUTE_RESPONSE_WINDOW) {
    return "The 48-hour reply window has ended. Anyone can now apply the default ruling.";
  }
  return null;
}

/** challengeRejection (single, the worker) / challengeContestRejection (contest, one entry). */
export function challengeBlocker(
  m: Pick<Meta, "resolved" | "rejectedAt" | "inDispute" | "contest">,
  now: bigint,
  alreadyChallenged: boolean,
): string | null {
  if (m.resolved) return SETTLED;
  if (m.rejectedAt === 0n) return "There is no rejection to challenge.";
  if (alreadyChallenged || (!m.contest && m.inDispute)) return "You already challenged this rejection.";
  if (now > m.rejectedAt + REJECTION_CHALLENGE_WINDOW) return "The 48-hour challenge window has ended.";
  return null;
}

/** submitWork by the assigned worker. */
export function submitWorkBlocker(
  m: Pick<Meta, "resolved" | "deadline" | "submittedResultHash">,
  now: bigint,
): string | null {
  if (m.resolved) return SETTLED;
  if (m.submittedResultHash) return "You already submitted work. The poster is reviewing it.";
  if (now > m.deadline) return "The deadline has passed, so work can no longer be submitted.";
  return null;
}

/** replaceContestEntry: until the contest closes. */
export function replaceEntryBlocker(paused: boolean, closedAt: bigint): string | null {
  if (paused) return "Entries are paused right now. Existing settlements still work.";
  if (closedAt > 0n) return "The contest has closed, so entries can no longer be replaced.";
  return null;
}
