import { isAddress, type Address } from "viem";
import type { BountyReader } from "./bounties.js";
import type { FacadeConfig } from "./config.js";

/**
 * Quest-platform verification: does this wallet have the on-chain history a
 * Galxe or Zealy task is asking about?
 *
 * Both platforms take the same shape of integration - they hand us a wallet
 * address and read a JSON answer - so one endpoint serves both, and serves
 * every task at once rather than one endpoint per task. Galxe scores the
 * response with a JS expression (`function(r){ return r.took_bounty }`), Zealy
 * reads the single `result` field that appears when `?task=` is given.
 *
 * The reason this matters at all: neither platform lists Arc among the chains
 * it verifies natively, and for a long time that was read as "quests are
 * impossible on Arc". It never was. Galxe's REST credential and Zealy's `api`
 * task both call an endpoint the project hosts, with no chain restriction
 * anywhere in either contract. This file is that endpoint.
 */

/** Tasks a campaign can point at. Names are part of the public contract with
 * the campaign config - renaming one silently breaks a live quest. */
export const QUEST_TASKS = [
  "took_bounty",
  "submitted_work",
  // takeBounty() has no msg.sender != poster check, so posting a bounty and
  // then taking it yourself clears "post one" and "do one" in a closed loop.
  // Only this task means "someone else's".
  "submitted_for_other",
  "completed_bounty",
  "posted_bounty",
] as const;

export type QuestTask = (typeof QUEST_TASKS)[number];

export function isQuestTask(value: string): value is QuestTask {
  return (QUEST_TASKS as readonly string[]).includes(value);
}

export type QuestStatus = {
  address: Address;
  network: string;
  brand: string;
  /** 1 / 0 rather than true / false: Galxe's evaluator wants a number back,
   * and `return r.took_bounty` is a shorter thing to paste into a campaign
   * than `return r.tookBounty ? 1 : 0`. */
  took_bounty: 0 | 1;
  submitted_work: 0 | 1;
  submitted_for_other: 0 | 1;
  completed_bounty: 0 | 1;
  posted_bounty: 0 | 1;
  counts: {
    taken: number;
    submitted: number;
    submittedForOther: number;
    completed: number;
    posted: number;
  };
};

/**
 * Raised when the chain could not be read inside the request budget.
 *
 * Deliberately NOT folded into a zero answer. A quest that tells a user who
 * did the work that they are ineligible is worse than one that tells them to
 * retry: the first loses the participant and earns a support message, the
 * second costs a click. The route turns this into a 503.
 */
export class QuestIndeterminate extends Error {
  constructor(cause: string) {
    super(`could not verify within budget: ${cause}`);
    this.name = "QuestIndeterminate";
  }
}

/**
 * Galxe cancels a REST credential that has not answered in 5 seconds, so the
 * verifier gives up at 4 and reports indeterminate. The remaining second is
 * for our own serialisation and the platform's network hop.
 */
const BUDGET_MS = 4_000;

/** How long a negative answer stays cached. Short, because the whole point of
 * the quest is that the user goes and does the thing, then comes back. */
const NEGATIVE_TTL_MS = 15_000;

export class QuestVerifier {
  /**
   * Addresses that have already satisfied a task, remembered for the process
   * lifetime and never downgraded.
   *
   * Every fact here is monotonic in practice - having taken a bounty is not
   * something that un-happens - so a later RPC failure, or an adapter index
   * that stops listing an expired job, must not revoke a completion the user
   * already earned. Positives are cheap to keep and expensive to lose.
   */
  private readonly earned = new Map<string, Set<QuestTask>>();
  /** Last counts actually read for an address, so the all-earned shortcut can
   * still answer with real numbers instead of placeholders. */
  private readonly lastCounts = new Map<string, QuestStatus["counts"]>();
  private readonly negatives = new Map<string, { at: number; status: QuestStatus }>();

  /**
   * M-12: all three maps above are keyed by any syntactically-valid address
   * string a caller sends (see parseAddress - no on-chain existence check),
   * and `lastCounts` in particular was written unconditionally for every
   * address ever verified and never deleted, so a flood of distinct
   * random-but-valid addresses grew it without bound (earned is naturally
   * smaller - only addresses with >=1 real earned task are stored there -
   * and negatives self-clears on a full earn, but neither is actually
   * bounded either).
   *
   * Fixed with one insertion-ordered ledger of tracked keys, shared across
   * all three maps since they're always read/written together by the same
   * key - evicting from just one would let them drift out of sync. Same
   * "size cap over setInterval sweep" reasoning as TtlCache (see cache.ts):
   * this runs as a Vercel function as often as a long-lived process, so a
   * background timer is the wrong tool.
   */
  private static readonly MAX_TRACKED_ADDRESSES = 10_000;
  private readonly addressOrder = new Set<string>();

  constructor(
    private readonly reader: BountyReader,
    private readonly config: FacadeConfig,
  ) {}

  /** Marks `key` as most-recently-used and evicts the oldest tracked address
   * from all three maps once the cap is exceeded. Call on every path that
   * reads OR writes earned/lastCounts/negatives for a key, so a hot,
   * frequently-re-verified address (the common case - a platform polling the
   * same real user until they finish a task) doesn't get evicted ahead of
   * addresses nobody has asked about in a while. */
  private touch(key: string): void {
    this.addressOrder.delete(key);
    this.addressOrder.add(key);
    while (this.addressOrder.size > QuestVerifier.MAX_TRACKED_ADDRESSES) {
      const oldest = this.addressOrder.values().next().value;
      if (oldest === undefined) break;
      this.addressOrder.delete(oldest);
      this.earned.delete(oldest);
      this.lastCounts.delete(oldest);
      this.negatives.delete(oldest);
    }
  }

  /** Normalises whatever the platform sent us into a checksum-free lower-case
   * address, or null if it is not an address at all. Galxe can be configured
   * to send `$addressWithout0x`, and Zealy's payload shape is set in its task
   * editor rather than in public docs, so both are accepted. */
  static parseAddress(raw: unknown): Address | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    const candidate = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
    if (!isAddress(candidate)) return null;
    return candidate.toLowerCase() as Address;
  }

  async verify(address: Address): Promise<QuestStatus> {
    const key = address.toLowerCase();
    const done = this.earned.get(key);

    // Everything already earned, nothing left to look up. This is the path a
    // re-verification takes, and it costs no RPC at all - which is what keeps
    // a campaign burst from queueing behind the reader's paced lane.
    if (done && done.size === QUEST_TASKS.length) {
      this.touch(key);
      return this.fromEarned(address, done, this.lastCounts.get(key));
    }

    const cachedNegative = this.negatives.get(key);
    if (cachedNegative && Date.now() - cachedNegative.at < NEGATIVE_TTL_MS) {
      this.touch(key);
      return cachedNegative.status;
    }

    const deadline = Date.now() + BUDGET_MS;
    const left = () => deadline - Date.now();

    let assigned: bigint[];
    let posted: bigint[];
    try {
      [assigned, posted] = await Promise.all([
        this.reader.assignedJobs(address),
        this.reader.postedJobs(address),
      ]);
    } catch (err) {
      throw new QuestIndeterminate(err instanceof Error ? err.message : String(err));
    }

    let submitted = 0;
    let submittedForOther = 0;
    let completed = 0;
    let truncated = false;

    // Metas are only needed to tell "took" apart from "submitted" and "paid".
    // Read them while there is budget; if the RPC is pacing us out, stop and
    // say so rather than reporting a zero we have not actually established.
    for (const jobId of assigned) {
      if (left() < 800) {
        truncated = true;
        break;
      }
      try {
        const { value } = await this.reader.get(jobId);
        // M-02: this used to be `/[1-9a-f]/i.test(value.submittedResultHash.slice(2))`
        // - an accidental non-empty-string check that happened to work only
        // because it was never fed a string starting with all-zero hex. It
        // treated `submittedResultHash` as a `0x`-prefixed hex value (hence
        // `.slice(2)`), but it is an IPFS hash string, not hex - a real
        // emptiness check is both correct and simpler.
        const hasSubmission = value.submittedResultHash.length > 0;
        if (hasSubmission) submitted++;
        if (hasSubmission && value.poster.toLowerCase() !== address.toLowerCase()) submittedForOther++;
        // M-02: `resolved && hasSubmission` alone is ambiguous and was a
        // permanent false-positive - finalizeRejection (rejectBounty, never
        // challenged, then finalized) and a lost dispute ALSO leave
        // resolved=true with submittedResultHash still set, but pay the
        // *poster* back via _rejectAndRefund, never the worker. This can't
        // just ask "did BountyCompleted fire for this jobId" via a log scan
        // to settle it directly - see the "one eth_call, no log scan" note
        // on BountyReader.assignedJobs() in bounties.ts: the same 5s Galxe
        // budget that rules out getLogs there applies to every job read in
        // this loop too. Instead this narrows using fields already in hand
        // from the same eth_call:
        //   - rejectedAt == 0 && disputeRaisedAt == 0: the ONLY way to reach
        //     resolved+submitted without ever touching the rejection or
        //     dispute machinery is approveBounty/autoApprove - worker paid,
        //     unambiguous.
        //   - rejectedAt != 0 && disputeRaisedAt == 0: rejectBounty ran and
        //     was never challenged, so the only path to `resolved` from
        //     there is finalizeRejection - refunded to poster, unambiguous.
        //   - disputeRaisedAt != 0 (rejected-then-challenged, or a direct
        //     disputeBounty call either way): resolveDispute/
        //     claimDefaultRuling/claimArbitratorTimeout all set resolved=true
        //     without persisting which side was paid (payProvider only ever
        //     reaches an event, never a BountyMeta field) - genuinely
        //     ambiguous from meta alone. Known, accepted tradeoff: a worker
        //     who WON a dispute is not credited as completed_bounty here
        //     (undercounts that one narrow case) - preferred over the
        //     previous bug, which overcounted the far more common
        //     rejected/lost-dispute case as paid.
        if (value.resolved && hasSubmission && value.rejectedAt === 0n && value.disputeRaisedAt === 0n) {
          completed++;
        }
      } catch {
        truncated = true;
        break;
      }
    }

    const status: QuestStatus = {
      address,
      network: this.config.network,
      brand: this.config.brandName,
      took_bounty: assigned.length > 0 ? 1 : 0,
      submitted_work: submitted > 0 ? 1 : 0,
      submitted_for_other: submittedForOther > 0 ? 1 : 0,
      completed_bounty: completed > 0 ? 1 : 0,
      posted_bounty: posted.length > 0 ? 1 : 0,
      counts: {
        taken: assigned.length,
        submitted,
        submittedForOther,
        completed,
        posted: posted.length,
      },
    };

    // A truncated pass can only under-report the submission-derived tasks. If
    // it under-reported all of them, we learned nothing worth caching and the
    // caller deserves a retry instead of a false negative.
    if (truncated && status.submitted_work === 0 && status.completed_bounty === 0) {
      throw new QuestIndeterminate("RPC budget exhausted before every assigned bounty was read");
    }

    this.remember(key, status);
    return this.merge(address, key, status);
  }

  private remember(key: string, status: QuestStatus): void {
    this.touch(key);
    const set = this.earned.get(key) ?? new Set<QuestTask>();
    for (const task of QUEST_TASKS) {
      if (status[task] === 1) set.add(task);
    }
    if (set.size > 0) this.earned.set(key, set);
    this.lastCounts.set(key, status.counts);

    const anyMissing = QUEST_TASKS.some(t => status[t] === 0);
    if (anyMissing) this.negatives.set(key, { at: Date.now(), status });
    else this.negatives.delete(key);
  }

  /** Folds previously earned tasks back in, so a partial read can add to a
   * user's standing but never subtract from it. */
  private merge(address: Address, key: string, status: QuestStatus): QuestStatus {
    const set = this.earned.get(key);
    if (!set) return status;
    const merged = { ...status };
    for (const task of QUEST_TASKS) {
      if (set.has(task)) merged[task] = 1;
    }
    return merged;
  }

  private fromEarned(
    address: Address,
    set: Set<QuestTask>,
    counts: QuestStatus["counts"] | undefined,
  ): QuestStatus {
    return {
      address,
      network: this.config.network,
      brand: this.config.brandName,
      took_bounty: set.has("took_bounty") ? 1 : 0,
      submitted_work: set.has("submitted_work") ? 1 : 0,
      submitted_for_other: set.has("submitted_for_other") ? 1 : 0,
      completed_bounty: set.has("completed_bounty") ? 1 : 0,
      posted_bounty: set.has("posted_bounty") ? 1 : 0,
      counts: counts ?? { taken: 0, submitted: 0, submittedForOther: 0, completed: 0, posted: 0 },
    };
  }
}
