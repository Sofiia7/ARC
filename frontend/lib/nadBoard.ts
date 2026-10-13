// Pure NadBounty board helpers. No React, no wagmi, no browser APIs: safe to import from node:test.
import { nadStatus, type Meta, type NadStatus, type NadStatusCtx } from "./nadStatus";
import { ESCROW_STATUS } from "./nadStats";

/** AgenticCommerce JobStatus (contracts/src/base/AgenticCommerce.sol). Completed means paid, Rejected means refunded. */
export { ESCROW_STATUS };

/** What nadStatus uses to refine a label (lib/nadStatus.ts). Every field is optional. */
export type StatusCtx = NadStatusCtx;
/** The context inputs the loader can assemble from chain reads. */
export type StatusInput = {
  escrowStatus?: unknown;
  contestState?: ContestState | null;
  anyAwarded?: boolean;
  nowSeconds?: bigint;
};
/** Return value of getContestState: entryCount, closedAt, reviewDeadline, resolved. */
export type ContestState = readonly [entryCount: bigint, closedAt: bigint, reviewDeadline: bigint, resolved: boolean];
export type NadJob = { meta: Meta; status: NadStatus; ctx: StatusCtx };

export type SortBy = "newest" | "reward-desc" | "deadline-soon";
export type BoardTab = "open" | "settled" | "all";
export const BOARD_TABS: readonly { id: BoardTab; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "settled", label: "Settled" },
  { id: "all", label: "All" },
];

/** Hard cap on how many of the newest jobs the board and My Tasks read. */
export const BOARD_LIMIT = 100;

/** uint8 from AgenticCommerce.getJob. Anything outside 0-5 is treated as unknown. */
export function normalizeEscrowStatus(value: unknown): number | undefined {
  const n = typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 5 ? n : undefined;
}

/**
 * Assemble the nadStatus context for one job. Contest-only fields stay undefined for plain bounties. For a contest,
 * closedAt is passed even when it is 0n: nadStatus reads "closedAt is defined" as "the contest state is known" and 0n
 * as "still taking entries".
 */
export function buildStatusCtx(isContest: boolean, input: StatusInput = {}): StatusCtx {
  const ctx: StatusCtx = {};
  const escrow = normalizeEscrowStatus(input.escrowStatus);
  if (escrow !== undefined) ctx.escrowStatus = escrow;
  if (isContest && input.contestState) {
    ctx.entryCount = Number(input.contestState[0]);
    ctx.closedAt = input.contestState[1];
  }
  if (isContest && input.anyAwarded !== undefined) ctx.anyAwarded = input.anyAwarded;
  if (input.nowSeconds !== undefined) ctx.nowSeconds = input.nowSeconds;
  return ctx;
}

export const statusWithCtx = (meta: Meta, ctx: StatusCtx): NadStatus => nadStatus(meta, ctx);

export function makeJob(meta: Meta, input: StatusInput = {}): NadJob {
  const ctx = buildStatusCtx(meta.contest, input);
  return { meta, ctx, status: statusWithCtx(meta, ctx) };
}

// ---- tabs -----------------------------------------------------------------------------------------------------

export type JobBucket = "open" | "settled" | "active";
/** Open: takeable or enterable. Settled: finished, paid or refunded. Active: everything in between. */
export function bucketOf(job: Pick<NadJob, "meta" | "status" | "ctx">): JobBucket {
  if (job.status.kind === "open") return "open";
  const escrow = job.ctx.escrowStatus;
  if (
    (job.meta.resolved && !job.meta.inDispute) ||
    escrow === ESCROW_STATUS.Completed ||
    escrow === ESCROW_STATUS.Rejected
  )
    return "settled";
  return "active";
}

export function filterByTab<T extends Pick<NadJob, "meta" | "status" | "ctx">>(jobs: readonly T[], tab: BoardTab): T[] {
  return tab === "all" ? [...jobs] : jobs.filter((j) => bucketOf(j) === tab);
}

export function tabCounts(jobs: readonly Pick<NadJob, "meta" | "status" | "ctx">[]): Record<BoardTab, number> {
  let open = 0,
    settled = 0;
  for (const job of jobs) {
    const bucket = bucketOf(job);
    if (bucket === "open") open++;
    else if (bucket === "settled") settled++;
  }
  return { open, settled, all: jobs.length };
}

/** Open when anything is open, otherwise All so the board never lands on an empty tab with history behind it. */
export function defaultTab(counts: Record<BoardTab, number>): BoardTab {
  return counts.open > 0 ? "open" : "all";
}

// ---- filters and sorting --------------------------------------------------------------------------------------

export type BoardFilters = {
  tab: BoardTab;
  search: string;
  category: string;
  agentOnly: boolean;
  humanOnly: boolean;
  sortBy: SortBy;
};

const byIdDesc = (a: bigint, b: bigint) => (a === b ? 0 : a > b ? -1 : 1);

export function matchesSearch(job: Pick<NadJob, "meta" | "status">, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  const { meta, status } = job;
  const haystack = [
    meta.category,
    ...meta.tags,
    meta.contest ? "contest encrypted" : "bounty",
    status.label,
    `${meta.jobId}`,
  ];
  return haystack.join(" ").toLowerCase().includes(q);
}

export function sortJobs<T extends Pick<NadJob, "meta">>(jobs: readonly T[], sortBy: SortBy, nowSeconds: bigint): T[] {
  const arr = [...jobs];
  if (sortBy === "newest") return arr.sort((x, y) => byIdDesc(x.meta.jobId, y.meta.jobId));
  if (sortBy === "reward-desc")
    return arr.sort((x, y) =>
      x.meta.reward === y.meta.reward ? byIdDesc(x.meta.jobId, y.meta.jobId) : x.meta.reward < y.meta.reward ? 1 : -1,
    );
  // Deadline soon: upcoming deadlines first (nearest on top), then deadlines already passed (most recent first).
  return arr.sort((x, y) => {
    const xf = x.meta.deadline > nowSeconds,
      yf = y.meta.deadline > nowSeconds;
    if (xf !== yf) return xf ? -1 : 1;
    if (x.meta.deadline === y.meta.deadline) return byIdDesc(x.meta.jobId, y.meta.jobId);
    return xf ? (x.meta.deadline < y.meta.deadline ? -1 : 1) : x.meta.deadline > y.meta.deadline ? -1 : 1;
  });
}

export function applyBoardFilters<T extends NadJob>(
  jobs: readonly T[],
  filters: BoardFilters,
  nowSeconds: bigint,
): T[] {
  const kept = filterByTab(jobs, filters.tab).filter((job) => {
    const m = job.meta;
    if (filters.category && m.category !== filters.category) return false;
    if (filters.agentOnly && !m.agentOnly) return false;
    if (filters.humanOnly && !m.humanOnly) return false;
    return matchesSearch(job, filters.search);
  });
  return sortJobs(kept, filters.sortBy, nowSeconds);
}

// ---- time -----------------------------------------------------------------------------------------------------

/** Same wording as lib/format.ts secondsToDeadline, but against an explicit "now" (chain time). */
export function timeLeft(deadline: bigint, nowSeconds: bigint): { expired: boolean; label: string } {
  const diff = Number(deadline - nowSeconds);
  if (diff <= 0) return { expired: true, label: "Expired" };
  const days = Math.floor(diff / 86400),
    hours = Math.floor((diff % 86400) / 3600),
    mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return { expired: false, label: `${days}d ${hours}h` };
  if (hours > 0) return { expired: false, label: `${hours}h ${mins}m` };
  return { expired: false, label: `${mins}m` };
}

/** UTC calendar day, locale independent: 2026-10-12. */
export function isoDay(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

/** Chain time right now: the block timestamp seen at fetch time plus the wall-clock seconds since the fetch. */
export function estimateChainNow(chainNowAtFetch: bigint, fetchedAtMs: number, nowMs: number): bigint {
  const elapsed = Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000));
  return chainNowAtFetch + BigInt(elapsed);
}

/** Right-hand label of a row: time left for live jobs, the end date for finished ones. */
export function rowTimeLabel(job: Pick<NadJob, "meta" | "status" | "ctx">, nowSeconds: bigint): string {
  return bucketOf(job) === "settled"
    ? `Ended ${isoDay(job.meta.deadline)}`
    : timeLeft(job.meta.deadline, nowSeconds).label;
}

// ---- ids ------------------------------------------------------------------------------------------------------

/** Index range of the newest `limit` entries of allJobIds. */
export function latestIndexRange(total: bigint, limit = BOARD_LIMIT): { start: bigint; count: number } {
  const cap = BigInt(Math.max(0, limit));
  const count = total > cap ? cap : total;
  return { start: total - count, count: Number(count) };
}

/** Union of several id lists, newest (highest id) first, cut to `limit`. */
export function mergeJobIds(lists: readonly (readonly bigint[])[], limit = BOARD_LIMIT): bigint[] {
  const seen = new Set<bigint>();
  for (const list of lists) for (const id of list) seen.add(id);
  return [...seen].sort(byIdDesc).slice(0, limit);
}

/** Empty input means 0 (no agent). Anything that is not a plain non-negative integer returns null. */
export function parseAgentIdInput(raw: string): bigint | null {
  const text = raw.trim();
  if (text === "") return 0n;
  return /^\d{1,30}$/.test(text) ? BigInt(text) : null;
}
