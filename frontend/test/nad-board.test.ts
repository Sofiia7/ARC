import test from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_TABS,
  applyBoardFilters,
  bucketOf,
  buildStatusCtx,
  defaultTab,
  estimateChainNow,
  filterByTab,
  isoDay,
  latestIndexRange,
  makeJob,
  matchesSearch,
  mergeJobIds,
  normalizeEscrowStatus,
  parseAgentIdInput,
  rowTimeLabel,
  sortJobs,
  statusWithCtx,
  tabCounts,
  timeLeft,
  type BoardFilters,
  type ContestState,
  type NadJob,
} from "../lib/nadBoard";
import { hydrateJobs, loadMyJobIds, loadNadBoard, loadNadJobs, readMany, type ReadCall } from "../lib/nadBoardLoad";
import type { Meta } from "../lib/nadStatus";

const NOW = 1_800_000_000n;
const DAY = 86400n;
const ADAPTER = "0x00000000000000000000000000000000000000a1" as const;
const ESCROW = "0x00000000000000000000000000000000000000e1" as const;
const cfg = { adapter: ADAPTER, escrow: ESCROW };

// Only the fields the board reads are set; the rest of the on-chain struct is irrelevant here.
const meta = (overrides: Partial<Meta> = {}): Meta =>
  ({
    jobId: 1n,
    reward: 1_000_000n,
    deadline: NOW + 10n * DAY,
    category: "dev",
    tags: [] as string[],
    agentOnly: false,
    humanOnly: false,
    contest: false,
    resolved: false,
    inDispute: false,
    submittedResultHash: "",
    isTaken: false,
    ...overrides,
  }) as unknown as Meta;
const job = (overrides: Partial<Meta> = {}, input: Parameters<typeof makeJob>[1] = { nowSeconds: NOW }): NadJob =>
  makeJob(meta(overrides), input);

test("buildStatusCtx: a contest carries entry count and closedAt", () => {
  const closed: ContestState = [3n, NOW - DAY, NOW + 13n * DAY, false];
  assert.deepEqual(buildStatusCtx(true, { escrowStatus: 1, contestState: closed, nowSeconds: NOW }), {
    escrowStatus: 1,
    entryCount: 3,
    closedAt: NOW - DAY,
    nowSeconds: NOW,
  });
  const stillOpen: ContestState = [2n, 0n, 0n, false];
  // 0n is passed on purpose: nadStatus reads a defined closedAt as "contest state known", 0n as "still taking entries".
  assert.deepEqual(buildStatusCtx(true, { contestState: stillOpen }), { entryCount: 2, closedAt: 0n });
  assert.deepEqual(buildStatusCtx(true, { anyAwarded: false }), { anyAwarded: false });
  assert.deepEqual(buildStatusCtx(false, { anyAwarded: true }), {});
});

test("buildStatusCtx: plain bounties ignore contest state, and unknown escrow codes are dropped", () => {
  const state: ContestState = [9n, NOW, NOW, true];
  assert.deepEqual(buildStatusCtx(false, { escrowStatus: 3, contestState: state }), { escrowStatus: 3 });
  assert.deepEqual(buildStatusCtx(false, { escrowStatus: 9 }), {});
  assert.deepEqual(buildStatusCtx(false, { escrowStatus: -1 }), {});
  assert.deepEqual(buildStatusCtx(false, { escrowStatus: "3" }), {});
  assert.deepEqual(buildStatusCtx(false, {}), {});
  assert.deepEqual(buildStatusCtx(false), {});
});

test("normalizeEscrowStatus accepts 0-5 as number or bigint", () => {
  assert.equal(normalizeEscrowStatus(0), 0);
  assert.equal(normalizeEscrowStatus(5n), 5);
  assert.equal(normalizeEscrowStatus(6), undefined);
  assert.equal(normalizeEscrowStatus(1.5), undefined);
  assert.equal(normalizeEscrowStatus(undefined), undefined);
});

test("makeJob feeds nadStatus: paid, refunded, in review and still open read correctly", () => {
  assert.deepEqual(statusWithCtx(meta(), {}), { kind: "open", label: "Open" });
  const paid = makeJob(meta({ resolved: true }), { escrowStatus: 3, nowSeconds: NOW });
  assert.equal(paid.status.label, "Paid");
  assert.equal(paid.ctx.escrowStatus, 3);
  assert.equal(paid.ctx.nowSeconds, NOW);
  const refunded = makeJob(meta({ resolved: true, contest: true }), { escrowStatus: 4, nowSeconds: NOW });
  assert.equal(refunded.status.label, "Refunded");
  const closed: ContestState = [2n, NOW - DAY, NOW + 13n * DAY, false];
  const inReview = makeJob(meta({ contest: true, deadline: NOW - DAY }), { contestState: closed, nowSeconds: NOW });
  assert.equal(inReview.status.label, "In review");
  assert.equal(bucketOf(inReview), "active");
  const noEntries: ContestState = [0n, NOW - DAY, NOW + 13n * DAY, false];
  assert.equal(
    makeJob(meta({ contest: true, deadline: NOW - DAY }), { contestState: noEntries, nowSeconds: NOW }).status.label,
    "Expired",
  );
  const taking: ContestState = [1n, 0n, 0n, false];
  const open = makeJob(meta({ contest: true }), { contestState: taking, nowSeconds: NOW });
  assert.deepEqual(open.status, { kind: "open", label: "Open" });
  assert.equal(bucketOf(open), "open");
});

test("buckets: open, settled (paid or refunded) and active", () => {
  const open = job({ jobId: 1n });
  const paid = job({ jobId: 2n, resolved: true }, { escrowStatus: 3, nowSeconds: NOW });
  const refunded = job({ jobId: 3n, resolved: true, contest: true }, { escrowStatus: 4, nowSeconds: NOW });
  const taken = job({ jobId: 4n, isTaken: true });
  const disputed = job({ jobId: 5n, resolved: true, inDispute: true });
  assert.equal(bucketOf(open), "open");
  assert.equal(bucketOf(paid), "settled");
  assert.equal(bucketOf(refunded), "settled");
  assert.equal(bucketOf(taken), "active");
  assert.equal(bucketOf(disputed), "active");
});

test("an escrow that says paid or refunded settles the job even if the adapter flag lags", () => {
  const lagging = {
    meta: meta({ jobId: 6n }),
    status: { kind: "in-review", label: "In progress" },
    ctx: { escrowStatus: 4 },
  };
  assert.equal(bucketOf(lagging), "settled");
  assert.equal(bucketOf({ ...lagging, ctx: { escrowStatus: 1 } }), "active");
});

test("tab filtering, counts and the default tab", () => {
  const jobs = [
    job({ jobId: 1n, resolved: true }, { escrowStatus: 3 }),
    job({ jobId: 2n, resolved: true, contest: true }, { escrowStatus: 3 }),
    job({ jobId: 3n, resolved: true, contest: true }, { escrowStatus: 4 }),
    job({ jobId: 4n }),
    job({ jobId: 5n }),
    job({ jobId: 6n, isTaken: true }),
  ];
  assert.deepEqual(
    filterByTab(jobs, "open").map((j) => j.meta.jobId),
    [4n, 5n],
  );
  assert.deepEqual(
    filterByTab(jobs, "settled").map((j) => j.meta.jobId),
    [1n, 2n, 3n],
  );
  assert.equal(filterByTab(jobs, "all").length, 6);
  assert.deepEqual(tabCounts(jobs), { open: 2, settled: 3, all: 6 });
  assert.equal(defaultTab(tabCounts(jobs)), "open");
  assert.equal(defaultTab(tabCounts(jobs.slice(0, 3))), "all");
  assert.equal(defaultTab({ open: 0, settled: 0, all: 0 }), "all");
  assert.deepEqual(
    BOARD_TABS.map((t) => t.id),
    ["open", "settled", "all"],
  );
});

test("sort: newest by id, reward with id tie-break, deadline soon puts upcoming first then the past", () => {
  const a = job({ jobId: 1n, reward: 5_000_000n, deadline: NOW + 3n * DAY });
  const b = job({ jobId: 2n, reward: 5_000_000n, deadline: NOW + 1n * DAY });
  const c = job({ jobId: 3n, reward: 1_000_000n, deadline: NOW - 2n * DAY });
  const d = job({ jobId: 4n, reward: 9_000_000n, deadline: NOW - 9n * DAY });
  const ids = (xs: NadJob[]) => xs.map((x) => x.meta.jobId);
  assert.deepEqual(ids(sortJobs([a, b, c, d], "newest", NOW)), [4n, 3n, 2n, 1n]);
  assert.deepEqual(ids(sortJobs([a, b, c, d], "reward-desc", NOW)), [4n, 2n, 1n, 3n]);
  assert.deepEqual(ids(sortJobs([a, b, c, d], "deadline-soon", NOW)), [2n, 1n, 3n, 4n]);
});

test("applyBoardFilters combines tab, category, audience flags and search", () => {
  const jobs = [
    job({ jobId: 1n, category: "dev", tags: ["rust"], agentOnly: true }),
    job({ jobId: 2n, category: "design", tags: ["logo"], humanOnly: true }),
    job({ jobId: 3n, category: "dev", contest: true }),
    job({ jobId: 4n, category: "dev", resolved: true }, { escrowStatus: 3 }),
  ];
  const base: BoardFilters = {
    tab: "open",
    search: "",
    category: "",
    agentOnly: false,
    humanOnly: false,
    sortBy: "newest",
  };
  const ids = (f: Partial<BoardFilters>) => applyBoardFilters(jobs, { ...base, ...f }, NOW).map((j) => j.meta.jobId);
  assert.deepEqual(ids({}), [3n, 2n, 1n]);
  assert.deepEqual(ids({ tab: "all" }), [4n, 3n, 2n, 1n]);
  assert.deepEqual(ids({ tab: "settled" }), [4n]);
  assert.deepEqual(ids({ category: "dev" }), [3n, 1n]);
  assert.deepEqual(ids({ agentOnly: true }), [1n]);
  assert.deepEqual(ids({ humanOnly: true }), [2n]);
  assert.deepEqual(ids({ search: "RUST" }), [1n]);
  assert.deepEqual(ids({ search: "contest" }), [3n]);
  assert.deepEqual(ids({ search: "#2" }), [2n]);
  assert.deepEqual(ids({ search: "nothing like this" }), []);
});

test("matchesSearch also finds a job by its status label", () => {
  const j = job({ jobId: 7n, resolved: true }, { escrowStatus: 3 });
  assert.equal(matchesSearch(j, j.status.label), true);
  assert.equal(matchesSearch(j, "   "), true);
});

test("timeLeft uses the given clock and the same wording as the legacy board", () => {
  assert.deepEqual(timeLeft(NOW + 3n * DAY + 5n * 3600n, NOW), { expired: false, label: "3d 5h" });
  assert.deepEqual(timeLeft(NOW + 2n * 3600n + 7n * 60n, NOW), { expired: false, label: "2h 7m" });
  assert.deepEqual(timeLeft(NOW + 59n * 60n, NOW), { expired: false, label: "59m" });
  assert.deepEqual(timeLeft(NOW, NOW), { expired: true, label: "Expired" });
  assert.deepEqual(timeLeft(NOW - 1n, NOW), { expired: true, label: "Expired" });
});

test("rowTimeLabel: time left for live jobs, an end date for settled ones", () => {
  const live = job({ deadline: NOW + DAY });
  assert.equal(rowTimeLabel(live, NOW), "1d 0h");
  const settled = job({ resolved: true, deadline: 1_792_041_026n }, { escrowStatus: 3 });
  assert.equal(rowTimeLabel(settled, NOW), "Ended 2026-10-15");
  assert.equal(isoDay(0n), "1970-01-01");
});

test("estimateChainNow adds elapsed wall-clock seconds to the block timestamp and never goes backwards", () => {
  assert.equal(estimateChainNow(1000n, 5_000, 12_900), 1007n);
  assert.equal(estimateChainNow(1000n, 5_000, 5_000), 1000n);
  assert.equal(estimateChainNow(1000n, 5_000, 4_000), 1000n);
});

test("latestIndexRange reads the newest entries and respects the hard cap", () => {
  assert.deepEqual(latestIndexRange(5n), { start: 0n, count: 5 });
  assert.deepEqual(latestIndexRange(100n), { start: 0n, count: 100 });
  assert.deepEqual(latestIndexRange(250n), { start: 150n, count: 100 });
  assert.deepEqual(latestIndexRange(0n), { start: 0n, count: 0 });
  assert.deepEqual(latestIndexRange(10n, 3), { start: 7n, count: 3 });
});

test("mergeJobIds dedupes, sorts newest first and cuts to the limit", () => {
  assert.deepEqual(mergeJobIds([[1n, 5n], [5n, 3n], []]), [5n, 3n, 1n]);
  assert.deepEqual(mergeJobIds([[1n, 2n, 3n, 4n]], 2), [4n, 3n]);
  assert.deepEqual(mergeJobIds([]), []);
});

test("parseAgentIdInput treats an empty field as 0 and rejects non-numbers", () => {
  assert.equal(parseAgentIdInput(""), 0n);
  assert.equal(parseAgentIdInput("   "), 0n);
  assert.equal(parseAgentIdInput("0"), 0n);
  assert.equal(parseAgentIdInput(" 10388 "), 10388n);
  assert.equal(parseAgentIdInput("12a"), null);
  assert.equal(parseAgentIdInput("-1"), null);
  assert.equal(parseAgentIdInput("1.5"), null);
  assert.equal(parseAgentIdInput("1".repeat(31)), null);
});

// ---- loader against a fake client ------------------------------------------------------------------------------

type Calls = string[];
function fakeClient(options: { multicall: boolean; failMetaFor?: bigint }) {
  const calls: Calls = [];
  const total = 5n;
  const metas: Record<string, Meta> = {
    "10": meta({ jobId: 10n, resolved: true }),
    "11": meta({ jobId: 11n, resolved: true, contest: true }),
    "12": meta({ jobId: 12n, resolved: true, contest: true }),
    "13": meta({ jobId: 13n }),
    "14": meta({ jobId: 14n, contest: true }),
  };
  const escrowStatus: Record<string, number> = { "10": 3, "11": 3, "12": 4, "13": 0, "14": 1 };
  const answer = (c: ReadCall): unknown => {
    const arg0 = c.args?.[0] as bigint | undefined;
    switch (c.functionName) {
      case "totalBounties":
        return total;
      case "allJobIds":
        return 10n + (arg0 as bigint);
      case "getBountyMeta":
        if (arg0 === options.failMetaFor) throw new Error("meta reverted");
        return metas[String(arg0)];
      case "getJob":
        return { id: arg0, status: escrowStatus[String(arg0)] };
      case "getContestState":
        return arg0 === 14n ? [2n, 0n, 0n, false] : [1n, NOW - DAY, NOW + 13n * DAY, true];
      case "getMyPostedBounties":
        return [10n, 12n];
      case "getMyAssignedBounties":
        return [12n, 13n];
      case "getAgentBounties":
        return [11n, 13n];
      default:
        throw new Error(`unexpected ${c.functionName}`);
    }
  };
  return {
    calls,
    chain: options.multicall
      ? { contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } } }
      : undefined,
    async multicall({ contracts }: { contracts: ReadCall[] }) {
      calls.push(`multicall:${contracts.length}`);
      return contracts.map((c) => {
        try {
          return { status: "success", result: answer(c) };
        } catch (error) {
          return { status: "failure", error };
        }
      });
    },
    async readContract(c: ReadCall) {
      calls.push(`read:${c.functionName}`);
      return answer(c);
    },
    async getBlock() {
      calls.push("block");
      return { timestamp: NOW };
    },
  };
}

test("loadNadBoard: four small requests for the whole board, with escrow and contest data applied", async () => {
  const client = fakeClient({ multicall: true });
  const snap = await loadNadBoard(client, cfg);
  assert.equal(snap.total, 5n);
  assert.equal(snap.truncated, false);
  assert.equal(snap.skipped, 0);
  assert.equal(snap.chainNow, NOW);
  assert.deepEqual(
    snap.jobs.map((j) => j.meta.jobId),
    [10n, 11n, 12n, 13n, 14n],
  );
  // totalBounties + block, then ids, then metas + escrow jobs, then contest states for the 3 contests.
  assert.deepEqual(client.calls, ["read:totalBounties", "block", "multicall:5", "multicall:10", "multicall:3"]);
  assert.deepEqual(
    snap.jobs.map((j) => j.ctx.escrowStatus),
    [3, 3, 4, 0, 1],
  );
  const byId = new Map(snap.jobs.map((j) => [j.meta.jobId, j]));
  assert.equal(byId.get(14n)?.ctx.entryCount, 2);
  assert.equal(byId.get(14n)?.ctx.closedAt, 0n);
  assert.equal(byId.get(14n)?.status.kind, "open");
  assert.equal(byId.get(12n)?.status.label, "Refunded");
  assert.equal(byId.get(11n)?.status.label, "Paid");
  assert.equal(byId.get(11n)?.ctx.closedAt, NOW - DAY);
  assert.equal(byId.get(10n)?.ctx.entryCount, undefined);
  assert.deepEqual(tabCounts(snap.jobs), { open: 2, settled: 3, all: 5 });
});

test("loadNadBoard: a bounty whose meta cannot be read is skipped, not fatal", async () => {
  const snap = await loadNadBoard(fakeClient({ multicall: true, failMetaFor: 12n }), cfg);
  assert.equal(snap.skipped, 1);
  assert.deepEqual(
    snap.jobs.map((j) => j.meta.jobId),
    [10n, 11n, 13n, 14n],
  );
});

test("loadNadBoard: the hard cap reads only the newest ids and says so", async () => {
  const client = fakeClient({ multicall: true });
  const snap = await loadNadBoard(client, cfg, 2);
  assert.equal(snap.truncated, true);
  assert.equal(snap.total, 5n);
  assert.deepEqual(
    snap.jobs.map((j) => j.meta.jobId),
    [13n, 14n],
  );
});

test("readMany falls back to parallel reads on a chain without Multicall3", async () => {
  const client = fakeClient({ multicall: false });
  const snap = await loadNadBoard(client, cfg);
  assert.equal(snap.jobs.length, 5);
  assert.equal(
    client.calls.some((c) => c.startsWith("multicall")),
    false,
  );
  assert.deepEqual(await readMany(client, []), []);
});

test("My Tasks: ids from three lists are merged newest first and hydrated through the same path", async () => {
  const client = fakeClient({ multicall: true });
  const { ids, truncated } = await loadMyJobIds(client, cfg, {
    address: "0x00000000000000000000000000000000000000b1",
    agentId: 7n,
  });
  assert.deepEqual(ids, [13n, 12n, 11n, 10n]);
  assert.equal(truncated, false);
  assert.deepEqual(client.calls, ["multicall:3"]);
  const snap = await loadNadJobs(client, cfg, ids);
  assert.deepEqual(
    snap.jobs.map((j) => j.meta.jobId),
    [13n, 12n, 11n, 10n],
  );
  const noAgent = await loadMyJobIds(fakeClient({ multicall: true }), cfg, {
    address: "0x00000000000000000000000000000000000000b1",
    agentId: 0n,
  });
  assert.deepEqual(noAgent.ids, [13n, 12n, 10n]);
});

test("My Tasks: an empty wallet needs no hydration reads", async () => {
  const client = fakeClient({ multicall: true });
  const snap = await loadNadJobs(client, cfg, []);
  assert.deepEqual(snap.jobs, []);
  assert.equal(
    client.calls.some((c) => c.startsWith("multicall")),
    false,
  );
});

test("hydrateJobs reads contest entries only for resolved contests whose escrow job expired", async () => {
  const calls: string[] = [];
  const answer = (c: ReadCall): unknown => {
    const id = c.args?.[0] as bigint;
    switch (c.functionName) {
      case "getBountyMeta":
        return meta({ jobId: id, contest: true, resolved: true });
      case "getJob":
        return { id, status: 5 };
      case "getContestState":
        return [2n, NOW - DAY, NOW + DAY, true];
      case "getContestEntries":
        return id === 20n ? [{ awarded: false }, { awarded: true }] : [{ awarded: false }];
      default:
        throw new Error();
    }
  };
  const client = {
    chain: { contracts: { multicall3: {} } },
    async multicall({ contracts }: { contracts: ReadCall[] }) {
      calls.push(contracts.map((c) => c.functionName)[0]);
      return contracts.map((c) => ({ status: "success", result: answer(c) }));
    },
    async readContract(c: ReadCall) {
      return answer(c);
    },
    async getBlock() {
      return { timestamp: NOW };
    },
  };
  const { jobs } = await hydrateJobs(client, cfg, [20n, 21n], NOW);
  assert.deepEqual(calls, ["getBountyMeta", "getContestState", "getContestEntries"]);
  assert.equal(jobs[0].ctx.anyAwarded, true);
  assert.equal(jobs[0].status.label, "Paid");
  assert.equal(jobs[1].ctx.anyAwarded, false);
  assert.equal(jobs[1].status.label, "Expired and refunded");
});
