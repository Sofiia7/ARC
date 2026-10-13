import type { Address } from "viem";
import { selectNadSettlement, type NadKeeperMeta, type NadSettlement } from "./nadKeeper.js";

const DAY = 86_400n;
/** Mirrors the adapter's APPROVAL_TIMEOUT (14 days), REJECTION_CHALLENGE_WINDOW and DISPUTE_RESPONSE_WINDOW (48 hours), ARBITRATOR_TIMEOUT (30 days). */
export const NAD_WINDOWS = {
  approval: 14n * DAY,
  challenge: 2n * DAY,
  response: 2n * DAY,
  arbitrator: 30n * DAY,
} as const;

/** How the address relates to the job. */
export type NadPendingRole = "poster" | "worker" | "entrant";

/** Decisions that only a party to the job can take, inside a deadline. */
export type NadResponseAction =
  | "approveBounty"
  | "challengeRejection"
  | "respondToDispute"
  | "pickContestWinners"
  | "challengeContestRejection"
  | "respondToContestChallenges";

type NadPendingBase = {
  jobId: bigint;
  /** How the address relates to the job. */
  role: NadPendingRole;
  reason: string;
};

/**
 * A settlement anyone may trigger right now, with no judgment needed. The whole
 * call is `agent[action](jobId)`.
 */
export type NadPendingClaim = NadPendingBase & {
  kind: "claim";
  /** The `NadBountyAgent` method to call with this jobId. */
  action: NadSettlement;
  expiresAt?: undefined;
};

/**
 * A decision for this role that is open now and ends at `expiresAt` (unix
 * seconds), after which the other side may win by default. The method needs
 * more than the jobId (a score, a reason or evidence CID), so decide first.
 */
export type NadPendingDecision = NadPendingBase & {
  kind: "respond";
  /** The `NadBountyAgent` method to call. */
  action: NadResponseAction;
  expiresAt: bigint;
};

/** `{ jobId, role, action }` plus `kind` to tell the two apart. */
export type NadPendingAction = NadPendingClaim | NadPendingDecision;

export type NadPendingMeta = NadKeeperMeta & {
  poster: Address;
  assignedProvider: Address;
  agentId: bigint;
  disputeByWorker: boolean;
};

export type NadPendingContest = {
  closedAt: bigint;
  entryCount: number;
  challenges: readonly { index: number; challengedAt: bigint; respondedAt: bigint }[];
  /** Needed to find the address among the entrants; omit for contests the address merely posted. */
  entries?: readonly { agentId: bigint; entrant: Address }[];
};

export type NadPendingJob = {
  meta: NadPendingMeta;
  contest?: NadPendingContest;
  /** The escrow job reached its Expired status (see `reconcileExpiredEscrow`). */
  escrowExpired: boolean;
};

const CLAIM_REASONS: Record<NadSettlement, string> = {
  autoApprove: "The poster did not review the submission within 14 days: anyone can release the worker's payout.",
  expireBounty:
    "The deadline passed without a winner: the escrow can be refunded to the poster (a taken bond is forfeited).",
  finalizeRejection: "The rejection was not challenged within 48 hours: the poster's refund can be finalized.",
  claimDefaultRuling: "One side did not answer the dispute within 48 hours: the other side wins by default.",
  claimArbitratorTimeout: "The arbitrator did not rule within 30 days: the escrow can be split 50/50.",
  reconcileExpiredEscrow: "The escrow job expired: the funds can be recovered by reconciling it.",
  settleContestSilence: "The poster did not review the contest within 14 days: the entries are paid out equally.",
  finalizeContestRejection: "Nobody challenged the rejection within 48 hours: the poster's refund can be finalized.",
  claimContestDefault: "The poster left a challenge unanswered for 48 hours: the challengers win by default.",
  claimContestArbitratorTimeout:
    "The arbitrator did not rule within 30 days: the escrow can be split between poster and challengers.",
};

const lower = (value: string) => value.toLowerCase();

/**
 * Pure policy behind `NadBountyAgent.getPendingActions`: given the on-chain state
 * of the jobs an address touches, list what can be done now. It never calls the
 * network, so it can run over indexed data too. Settlement choice is exactly
 * {@link selectNadSettlement}, the keeper's policy.
 *
 * A job produces at most one entry per action. When the address has several
 * roles on one job, the first of poster, worker, entrant is reported.
 */
export function computePendingActions(
  jobs: readonly NadPendingJob[],
  who: { address?: Address; agentId?: bigint },
  now: bigint,
): NadPendingAction[] {
  const address = who.address ? lower(who.address) : undefined;
  const agentId = who.agentId ?? 0n;
  const out: NadPendingAction[] = [];

  for (const { meta, contest, escrowExpired } of jobs) {
    if (meta.resolved) continue;
    const found: NadPendingAction[] = [];
    const add = (
      role: NadPendingRole,
      action: NadSettlement | NadResponseAction,
      kind: NadPendingAction["kind"],
      reason: string,
      expiresAt?: bigint,
    ) => {
      if (found.some((existing) => existing.action === action)) return;
      found.push({
        jobId: meta.jobId,
        role,
        action,
        kind,
        reason,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      } as NadPendingAction);
    };

    const isPoster = address !== undefined && lower(meta.poster) === address;
    const entryIndex =
      meta.contest && contest?.entries
        ? contest.entries.findIndex(
            (entry) =>
              (address !== undefined && lower(entry.entrant) === address) ||
              (agentId !== 0n && entry.agentId === agentId),
          )
        : -1;
    const isEntrant = entryIndex >= 0;
    const isWorker =
      !meta.contest &&
      meta.isTaken &&
      ((address !== undefined && lower(meta.assignedProvider) === address) ||
        (agentId !== 0n && meta.agentId === agentId));
    const role: NadPendingRole | undefined = isPoster
      ? "poster"
      : isWorker
        ? "worker"
        : isEntrant
          ? "entrant"
          : undefined;
    if (!role) continue;

    if (meta.contest) {
      if (!contest) throw new Error(`Contest state is required for job ${meta.jobId}`);
      const settlement = selectNadSettlement(meta, now, contest, escrowExpired);
      if (settlement) add(role, settlement, "claim", CLAIM_REASONS[settlement]);

      const rejected = meta.rejectedAt !== 0n;
      if (isPoster && contest.entryCount > 0 && contest.closedAt !== 0n && !rejected) {
        const ends = contest.closedAt + NAD_WINDOWS.approval;
        if (now <= ends) {
          add(
            "poster",
            "pickContestWinners",
            "respond",
            "The contest is closed and has entries: pick winners (or reject all) before the review window ends, " +
              "otherwise every entry is paid out equally.",
            ends,
          );
        }
      }
      if (isEntrant && rejected && now <= meta.rejectedAt + NAD_WINDOWS.challenge) {
        const challenged = contest.challenges.some((c) => c.index === entryIndex && c.challengedAt !== 0n);
        if (!challenged) {
          add(
            "entrant",
            "challengeContestRejection",
            "respond",
            "The poster rejected every entry: challenge your entry with evidence before the window closes, " +
              "otherwise the poster is refunded.",
            meta.rejectedAt + NAD_WINDOWS.challenge,
          );
        }
      }
      if (isPoster && rejected && meta.inDispute && now <= meta.disputeRaisedAt + NAD_WINDOWS.arbitrator) {
        const open = contest.challenges.filter((c) => c.challengedAt !== 0n && c.respondedAt === 0n);
        const overdue = open.some((c) => now > c.challengedAt + NAD_WINDOWS.response);
        if (open.length > 0 && !overdue) {
          const ends = open.reduce(
            (min, c) => (c.challengedAt + NAD_WINDOWS.response < min ? c.challengedAt + NAD_WINDOWS.response : min),
            open[0]!.challengedAt + NAD_WINDOWS.response,
          );
          add(
            "poster",
            "respondToContestChallenges",
            "respond",
            "Challenges against your rejection are unanswered: respond before the first deadline or the challengers win by default.",
            ends,
          );
        }
      }
    } else {
      const settlement = selectNadSettlement(meta, now, undefined, escrowExpired);
      if (settlement) add(role, settlement, "claim", CLAIM_REASONS[settlement]);

      if (isPoster && meta.submittedResultHash !== "" && meta.rejectedAt === 0n && !meta.inDispute) {
        const ends = meta.submittedAt + NAD_WINDOWS.approval;
        if (now <= ends) {
          add(
            "poster",
            "approveBounty",
            "respond",
            "Work was submitted: approve it (or reject it with a reason) before the review window ends, " +
              "otherwise anyone can release the payout to the worker.",
            ends,
          );
        }
      }
      if (isWorker && meta.rejectedAt !== 0n && !meta.inDispute && now <= meta.rejectedAt + NAD_WINDOWS.challenge) {
        add(
          "worker",
          "challengeRejection",
          "respond",
          "The poster rejected your submission: challenge it with evidence before the window closes, " +
            "otherwise the poster is refunded.",
          meta.rejectedAt + NAD_WINDOWS.challenge,
        );
      }
      if (meta.inDispute && meta.disputeResponseHash === "" && now <= meta.disputeRaisedAt + NAD_WINDOWS.response) {
        const respondent: NadPendingRole = meta.disputeByWorker ? "poster" : "worker";
        if ((respondent === "poster" && isPoster) || (respondent === "worker" && isWorker)) {
          add(
            respondent,
            "respondToDispute",
            "respond",
            "A dispute was opened against you: respond with your evidence before the window closes, " +
              "otherwise the other side wins by default.",
            meta.disputeRaisedAt + NAD_WINDOWS.response,
          );
        }
      }
    }
    out.push(...found);
  }
  return out;
}
