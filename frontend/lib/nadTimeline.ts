// Pure NadBounty timeline. No React, no wagmi, no browser APIs: safe to import from node:test.
//
// Every number below is read from contracts/src/monad/BountyAdapterV48.sol (test/nad-timeline.test.ts re-reads the
// Solidity source and fails if one of them drifts):
//   APPROVAL_TIMEOUT            = 14 days  poster's review window. Single taker: starts at submitWork (submittedAt).
//                                          Contest: starts when the contest closes (contestClosedAt: the deadline, or
//                                          earlier when every slot is filled or winners are picked early).
//                                          Poster can approve/pick/reject until then; after it anyone may call
//                                          autoApprove / settleContestSilence.
//   REJECTION_CHALLENGE_WINDOW  = 48 hours  starts at rejectedAt. Worker (single) or entrants (contest) may challenge;
//                                          without a challenge anyone may call finalizeRejection / finalizeContestRejection.
//   DISPUTE_RESPONSE_WINDOW     = 48 hours  starts at disputeRaisedAt (single) or at each challengedAt (contest, one
//                                          window per challenge). Silence lets anyone call claimDefaultRuling /
//                                          claimContestDefault.
//   ARBITRATOR_TIMEOUT          = 30 days   starts at disputeRaisedAt (contest: the first challenge). The arbitrator
//                                          may rule until then; after it anyone may call claimArbitratorTimeout /
//                                          claimContestArbitratorTimeout (50/50 split, no fee).
//   AC_EXPIRY_BUFFER            = 90 days   the escrow job (AgenticCommerce) expires at deadline + 90 days; from then
//                                          anyone may claimRefund it and reconcileExpiredEscrow replays the outcome.
import type { Meta } from "./nadStatus";

export const HOUR = 3600n;
export const DAY = 86400n;
export const APPROVAL_TIMEOUT = 14n * DAY;
export const REJECTION_CHALLENGE_WINDOW = 48n * HOUR;
export const DISPUTE_RESPONSE_WINDOW = 48n * HOUR;
export const ARBITRATOR_TIMEOUT = 30n * DAY;
export const AC_EXPIRY_BUFFER = 90n * DAY;

export type PhaseId = "deadline" | "review" | "rejection" | "response" | "arbitrator" | "recovery" | "settled";
/**
 * - done: the window is over; `end` (when known) is when it ended and is never in the future.
 * - current: the one window running now.
 * - upcoming: not started or not over yet.
 * - skipped: the bounty was settled before this window ran to its end, so it was not needed.
 */
export type PhaseState = "done" | "current" | "upcoming" | "skipped";
export type TimelinePhase = {
  id: PhaseId;
  label: string;
  /** One sentence: what this window is and what opens when it ends. */
  note: string;
  /** When the clock started, or null while it has not (a review window before any submission). */
  start: bigint | null;
  /** When the window ends (or ended), or null while the clock has not started. */
  end: bigint | null;
  /** While the clock has not started: what starts it, e.g. "when work is submitted". */
  startsWhen?: string;
  /** Shown instead of a date when there is none: "not needed, settled early", "answered", or how the job settled. */
  result?: string;
  state: PhaseState;
};

export type TimelineMeta = Pick<
  Meta,
  | "contest"
  | "deadline"
  | "resolved"
  | "inDispute"
  | "isTaken"
  | "submittedAt"
  | "rejectedAt"
  | "disputeRaisedAt"
  | "disputeResponseHash"
  | "disputeByWorker"
>;
export type TimelineChallenge = { challengedAt: bigint; respondedAt: bigint };
export type TimelineOptions = {
  /** Number of contest entries. A closed contest with none has no review window. */
  entryCount?: number;
  /** getContestChallenge for each entry (only entries with challengedAt > 0 count). */
  challenges?: readonly TimelineChallenge[];
  /** How a resolved bounty ended in a few words ("Paid", "Refunded to the poster"): recorded on the final step. */
  settledAs?: string;
};

const positive = (value: bigint | undefined) => value !== undefined && value > 0n;

/** "14 days", "48 hours", "30 days": built from the constants so the help text cannot drift from them. */
export function describeWindow(seconds: bigint): string {
  // Short windows read better in hours ("48 hours", as the contract names them); long ones in days.
  if (seconds >= 3n * DAY && seconds % DAY === 0n) {
    const days = seconds / DAY;
    return `${days} day${days === 1n ? "" : "s"}`;
  }
  const hours = seconds / HOUR;
  return `${hours} hour${hours === 1n ? "" : "s"}`;
}

/** One line per rule, for a "how the windows work" hint under the timeline. */
export function timelineRules(): string[] {
  return [
    `Review: ${describeWindow(APPROVAL_TIMEOUT)} from the submission (contest: from when it closes).`,
    `Rejection challenge: ${describeWindow(REJECTION_CHALLENGE_WINDOW)}.`,
    `Reply to a dispute or challenge: ${describeWindow(DISPUTE_RESPONSE_WINDOW)}.`,
    `Arbitrator: ${describeWindow(ARBITRATOR_TIMEOUT)} from the dispute.`,
    `Escrow recovery: ${describeWindow(AC_EXPIRY_BUFFER)} after the deadline.`,
  ];
}

/**
 * "in 3d 4h", "5h 10m ago", "in 12m", "now". Chain time on both sides.
 * Granularity matches lib/format.secondsToDeadline: days+hours, hours+minutes, minutes.
 */
export function formatRelative(target: bigint, now: bigint): string {
  const diff = target - now;
  const abs = diff < 0n ? -diff : diff;
  if (abs < 60n) return "now";
  const days = abs / DAY;
  const hours = (abs % DAY) / HOUR;
  const mins = (abs % HOUR) / 60n;
  const text = days > 0n ? `${days}d ${hours}h` : hours > 0n ? `${hours}h ${mins}m` : `${mins}m`;
  return diff > 0n ? `in ${text}` : `${text} ago`;
}

const SETTLED_EARLY = "not needed, settled early";
type Draft = Omit<TimelinePhase, "state"> & {
  finished: boolean;
  active: boolean;
  /**
   * When the window really ended, if that is known and differs from the scheduled `end` (a rejection ends the review
   * window the moment it is made). null: it ended at a time the chain does not record. Undefined: at the scheduled end.
   */
  endedAt?: bigint | null;
};

/**
 * The windows that apply to this bounty right now, in the order they run, with real timestamps.
 * - Only windows whose clock has started (or that always apply) are listed: a rejection challenge window appears
 *   once a rejection exists, the response and arbitrator windows once a dispute or challenge exists.
 * - Exactly one phase is "current" (the first one still running); finished windows are "done"; the rest "upcoming".
 * - A resolved bounty has no current phase and no escrow-recovery window, and ends with a "settled" step. A window that
 *   was still open when the bounty settled is "skipped" ("not needed, settled early"): a phase is never "done" with an
 *   end date in the future. The chain stores no settlement time, so a window whose scheduled end has passed is shown as
 *   ended on that date even if the bounty was in fact settled before it.
 * `closedAt` is the contest's stored closure (getContestState.closedAt, 0 while open); the deadline closes a contest
 * by itself, mirroring BountyAdapterV48.contestClosedAt. `now` is chain time.
 */
export function buildTimeline(
  meta: TimelineMeta,
  closedAt: bigint,
  now: bigint,
  options: TimelineOptions = {},
): TimelinePhase[] {
  const { contest, deadline, resolved } = meta;
  const challenges = (options.challenges ?? []).filter((c) => positive(c.challengedAt));
  const closed = contest ? (closedAt > 0n ? closedAt : now >= deadline ? deadline : 0n) : 0n;
  const submitted = positive(meta.submittedAt);
  const rejected = positive(meta.rejectedAt);
  const drafts: Draft[] = [];

  // 1. Deadline
  if (contest) {
    const early = closed > 0n && closed < deadline;
    drafts.push({
      id: "deadline",
      label: "Entries close",
      note: early
        ? "Entries closed early: every slot was filled or the poster picked winners before the deadline."
        : "Entries close at the deadline, or sooner when every entry slot is filled.",
      start: null,
      end: closed > 0n ? closed : deadline,
      finished: resolved || closed > 0n,
      active: !resolved && closed === 0n,
    });
  } else {
    const finished = resolved || submitted || now > deadline;
    drafts.push({
      id: "deadline",
      label: submitted ? "Work submitted" : "Work deadline",
      note: submitted
        ? "Work was submitted before the deadline."
        : "Work must be submitted by this time. After it, anyone can refund the poster.",
      start: null,
      end: submitted ? meta.submittedAt : deadline,
      finished,
      active: !finished,
    });
  }

  // 2. Review window
  const reviewStart = contest ? (closed > 0n ? closed : null) : submitted ? meta.submittedAt : null;
  const noEntries = contest && closed > 0n && options.entryCount === 0;
  if (!noEntries && !(reviewStart === null && resolved)) {
    const end = reviewStart === null ? null : reviewStart + APPROVAL_TIMEOUT;
    const finished = reviewStart !== null && (resolved || rejected || meta.inDispute || now > (end as bigint));
    drafts.push({
      id: "review",
      label: "Review window",
      note: contest
        ? "The poster picks winners or rejects all entries until then. After it, anyone can split the payment among all entries."
        : "The poster can approve, reject or dispute until then. After it, anyone can release payment to the worker.",
      start: reviewStart,
      end,
      ...(reviewStart === null ? { startsWhen: contest ? "when the contest closes" : "when work is submitted" } : {}),
      // The poster ends the window by rejecting or disputing.
      endedAt: rejected ? meta.rejectedAt : positive(meta.disputeRaisedAt) ? meta.disputeRaisedAt : undefined,
      finished,
      active: reviewStart !== null && !finished,
    });
  }

  // 3. Rejection challenge window
  if (rejected) {
    const end = meta.rejectedAt + REJECTION_CHALLENGE_WINDOW;
    // A contest keeps accepting challenges from other entrants after the first one; a single bounty stops at the first.
    const finished = resolved || (!contest && meta.inDispute) || now > end;
    drafts.push({
      id: "rejection",
      label: "Rejection challenge window",
      note: contest
        ? "Entrants have 48 hours to challenge the rejection. Without a challenge, anyone can finalize it and refund the poster."
        : "The worker has 48 hours to challenge the rejection. Without a challenge, anyone can finalize it and refund the poster.",
      start: meta.rejectedAt,
      end,
      // A single bounty's window ends with the worker's challenge; a contest's runs to its end for every entrant.
      endedAt: !contest && positive(meta.disputeRaisedAt) ? meta.disputeRaisedAt : undefined,
      finished,
      active: !finished,
    });
  }

  // 4. Response window and 5. arbitrator window
  const disputed = meta.inDispute || positive(meta.disputeRaisedAt) || challenges.length > 0;
  if (disputed) {
    if (contest) {
      const unanswered = challenges.filter((c) => !positive(c.respondedAt));
      const starts = challenges.map((c) => c.challengedAt);
      const start = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : meta.disputeRaisedAt;
      const ends = (unanswered.length ? unanswered : challenges).map((c) => c.challengedAt + DISPUTE_RESPONSE_WINDOW);
      const end = ends.length
        ? unanswered.length
          ? ends.reduce((a, b) => (a < b ? a : b))
          : ends.reduce((a, b) => (a > b ? a : b))
        : start + DISPUTE_RESPONSE_WINDOW;
      const answered = challenges.length > 0 && unanswered.length === 0;
      const finished = resolved || answered || now > end;
      drafts.push({
        id: "response",
        label: "Poster response window",
        note: "The poster has 48 hours to answer each challenge. If one goes unanswered, anyone can pay the challengers by default.",
        start,
        end,
        endedAt: answered ? challenges.map((c) => c.respondedAt).reduce((a, b) => (a > b ? a : b)) : undefined,
        finished,
        active: !finished,
      });
    } else {
      const end = meta.disputeRaisedAt + DISPUTE_RESPONSE_WINDOW;
      const answered = meta.disputeResponseHash !== "";
      const finished = resolved || answered || now > end;
      drafts.push({
        id: "response",
        label: meta.disputeByWorker ? "Poster response window" : "Worker response window",
        note: `${meta.disputeByWorker ? "The poster" : "The worker"} has 48 hours to reply. If they stay silent, anyone can apply the default ruling.`,
        start: meta.disputeRaisedAt,
        end,
        // The reply time of a single dispute is not stored.
        ...(answered ? { endedAt: null, result: "answered" } : {}),
        finished,
        active: !finished,
      });
    }
    const arbStart = positive(meta.disputeRaisedAt)
      ? meta.disputeRaisedAt
      : challenges.length
        ? challenges.map((c) => c.challengedAt).reduce((a, b) => (a < b ? a : b))
        : 0n;
    const arbEnd = arbStart + ARBITRATOR_TIMEOUT;
    const arbFinished = resolved || now > arbEnd;
    drafts.push({
      id: "arbitrator",
      label: "Arbitrator window",
      note: contest
        ? "The arbitrator can rule until then. If they do not, anyone can split the payment between the poster and the challengers."
        : "The arbitrator can rule until then. If they do not and both sides replied, anyone can split the payment 50/50.",
      start: arbStart,
      end: arbEnd,
      finished: arbFinished,
      active: !arbFinished,
    });
  }

  // 6. Escrow recovery. A single bounty nobody took was never funded in the escrow, so there is nothing to recover.
  if (!resolved && (contest || meta.isTaken)) {
    drafts.push({
      id: "recovery",
      label: "Escrow recovery",
      note: "If nobody settles the bounty by then, the escrow itself expires. Anyone can recover the funds, with no fee.",
      start: deadline,
      end: deadline + AC_EXPIRY_BUFFER,
      finished: false,
      active: now >= deadline,
    });
  }

  if (resolved) {
    drafts.push({
      id: "settled",
      label: "Settled",
      note: "The bounty is settled. The outcome above shows who was paid.",
      start: null,
      end: null,
      result: options.settledAs ?? "settled",
      finished: true,
      active: false,
    });
  }

  let currentTaken = false;
  return drafts.map(({ finished, active, endedAt, ...phase }): TimelinePhase => {
    if (finished) {
      const ended = endedAt !== undefined ? endedAt : phase.end;
      if (ended !== null && ended <= now) return { ...phase, end: ended, state: "done" };
      if (ended === null && phase.result) return { ...phase, end: null, state: "done" };
      // Still open when the bounty settled (or, for an unresolved job, an end that is not recorded).
      if (resolved) return { ...phase, result: SETTLED_EARLY, state: "skipped" };
      return { ...phase, end: null, state: "done" };
    }
    if (active && !currentTaken) {
      currentTaken = true;
      return { ...phase, state: "current" };
    }
    return { ...phase, state: "upcoming" };
  });
}

/**
 * The line shown next to a phase: its date and how long ago or from now, or the reason it has no date.
 * A done phase always reads "ended" with a past date; a skipped one says it was not needed.
 */
export function phaseWhenText(phase: TimelinePhase, now: bigint, formatDate: (ts: bigint) => string): string {
  if (phase.state === "skipped") return phase.result ?? "not needed, settled early";
  if (phase.end !== null) {
    return `${phase.state === "done" ? "ended" : "ends"} ${formatDate(phase.end)} · ${formatRelative(phase.end, now)}`;
  }
  if (phase.result) return phase.result;
  return `starts ${phase.startsWhen ?? "later"}`;
}

export function currentPhase(phases: readonly TimelinePhase[]): TimelinePhase | null {
  return phases.find((p) => p.state === "current") ?? null;
}
