import test from "node:test";
import assert from "node:assert/strict";
import {
  ARBITRATOR_TIMEOUT_RULING,
  buildNadStatsReport,
  classifyNadJob,
  contestNet,
  ESCROW_STATUS,
  formatUsdcUnits,
  nadFee,
  nadOutcomeLabel,
  singleNet,
  splitContestNet,
  ZERO_ADDRESS,
  type NadJobSnapshot,
  type NadStatsContext,
  type NadStatsEntry,
  type NadStatsMeta,
} from "../lib/nadStats";

const USDC = 1_000_000n;
const DAY = 86_400n;
const NOW = 1_800_000_000n;
const POSTER = "0x6abc2b575eC66701c17DAD96dDA97F22b837849E";
const WORKER = "0x0a46d80665E12Cb568541A20d39269F29318D066";
const OTHER = "0x1111111111111111111111111111111111111111";
const THIRD = "0x2222222222222222222222222222222222222222";
const AGENT_OWNER = "0x3333333333333333333333333333333333333333";

const meta = (o: Partial<NadStatsMeta> = {}): NadStatsMeta => ({
  jobId: 1n,
  poster: POSTER,
  reward: USDC,
  deadline: NOW + DAY,
  agentId: 0n,
  assignedProvider: ZERO_ADDRESS,
  submittedResultHash: "",
  isTaken: false,
  rejectedAt: 0n,
  inDispute: false,
  resolved: false,
  disputeRaisedAt: 0n,
  disputeResponseHash: "",
  disputeRulingHash: "",
  disputeByWorker: false,
  contest: false,
  maxEntries: 0,
  ...o,
});
const entry = (agentId: bigint, entrant: string, awarded: boolean): NadStatsEntry => ({ agentId, entrant, awarded });
const job = (m: Partial<NadStatsMeta>, escrowStatus: number, entries: NadStatsEntry[] = []): NadJobSnapshot => ({
  meta: meta(m),
  escrowStatus,
  entries,
});
const ctx: NadStatsContext = {
  nowSec: NOW,
  feeBps: 100n,
  ownerOf: (id) => (id === 10388n ? AGENT_OWNER : id === 77n ? null : OTHER),
};
const { Open, Funded, Submitted, Completed, Rejected, Expired } = ESCROW_STATUS;

// A resolved single-taker bounty the worker was paid for.
const paidSingle = (o: Partial<NadStatsMeta> = {}) =>
  job(
    { isTaken: true, resolved: true, submittedResultHash: "ipfs://result", assignedProvider: WORKER, ...o },
    Completed,
  );

// The same bounty in any escrow state.
const paidSingleWith = (status: number) =>
  job({ isTaken: true, resolved: true, submittedResultHash: "ipfs://result", assignedProvider: WORKER }, status);

test("the escrow status order matches AgenticCommerce.JobStatus", () => {
  assert.deepEqual(ESCROW_STATUS, { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 });
});

test("single-taker payout is the reward minus a 1% fee, rounded down like the contract", () => {
  assert.equal(nadFee(USDC), 10_000n);
  assert.equal(singleNet(USDC), 990_000n);
  assert.equal(singleNet(2n * USDC), 1_980_000n);
  assert.equal(singleNet(1_000_001n), 990_001n);
  assert.equal(nadFee(99n), 0n);
  assert.equal(singleNet(USDC, 250n), 975_000n);
});

test("contest net is reward minus the fee, split evenly with the remainder to the first winner", () => {
  assert.equal(contestNet(USDC), 990_000n);
  assert.deepEqual(splitContestNet(contestNet(USDC), 1), [990_000n]);
  assert.deepEqual(splitContestNet(contestNet(USDC), 2), [495_000n, 495_000n]);
  assert.deepEqual(splitContestNet(contestNet(USDC), 3), [330_000n, 330_000n, 330_000n]);
  // 1_000_001 -> fee 10_000 -> net 990_001: one unit of remainder for 2 winners, 1 for 3 winners
  assert.deepEqual(splitContestNet(contestNet(1_000_001n), 2), [495_001n, 495_000n]);
  assert.deepEqual(splitContestNet(contestNet(1_000_001n), 3), [330_001n, 330_000n, 330_000n]);
  // 5_000_000 -> net 4_950_000: no remainder for 4 winners, 6 units for 7 winners (4_950_000 = 7 * 707_142 + 6)
  assert.deepEqual(splitContestNet(4_950_000n, 4), [1_237_500n, 1_237_500n, 1_237_500n, 1_237_500n]);
  assert.deepEqual(splitContestNet(4_950_000n, 7), [
    707_148n,
    707_142n,
    707_142n,
    707_142n,
    707_142n,
    707_142n,
    707_142n,
  ]);
  for (const n of [1, 2, 3, 5, 7, 25]) {
    const parts = splitContestNet(contestNet(7_777_777n), n);
    assert.equal(parts.length, n);
    assert.equal(
      parts.reduce((a, b) => a + b, 0n),
      contestNet(7_777_777n),
    );
  }
  assert.deepEqual(splitContestNet(100n, 0), []);
});

test("USDC formatting trims trailing zeros like viem formatUnits", () => {
  assert.equal(formatUsdcUnits(0n), "0");
  assert.equal(formatUsdcUnits(1n), "0.000001");
  assert.equal(formatUsdcUnits(990_000n), "0.99");
  assert.equal(formatUsdcUnits(2_970_000n), "2.97");
  assert.equal(formatUsdcUnits(100n * USDC), "100");
  assert.equal(formatUsdcUnits(1_234_567n), "1.234567");
});

test("a paid single bounty credits the identity owner with reward minus fee", () => {
  const r = classifyNadJob(paidSingle({ agentId: 10388n, reward: 2n * USDC }), ctx);
  assert.equal(r.outcome, "paid");
  assert.equal(r.kind, "single");
  assert.equal(r.fee, 20_000n);
  assert.equal(r.netPaid, 1_980_000n);
  assert.deepEqual(r.payouts, [{ owner: AGENT_OWNER, agentId: 10388n, amount: 1_980_000n }]);
});

test("a human worker is credited at the wallet that took the bounty; an unreadable agent owner is the zero address", () => {
  const human = classifyNadJob(paidSingle(), ctx);
  assert.deepEqual(human.payouts, [{ owner: WORKER, agentId: 0n, amount: 990_000n }]);
  const burned = classifyNadJob(paidSingle({ agentId: 77n }), ctx);
  assert.equal(burned.payouts[0].owner, ZERO_ADDRESS);
  assert.equal(burned.payouts[0].amount, 990_000n);
});

test("contest with one winner on a 2 USDC reward pays 1.98 and charges 0.02", () => {
  const r = classifyNadJob(
    job({ contest: true, resolved: true, reward: 2n * USDC, maxEntries: 2 }, Completed, [
      entry(10388n, WORKER, true),
      entry(0n, OTHER, false),
    ]),
    ctx,
  );
  assert.equal(r.outcome, "paid");
  assert.equal(r.kind, "contest");
  assert.equal(r.fee, 20_000n);
  assert.equal(r.netPaid, 1_980_000n);
  assert.deepEqual(r.payouts, [{ owner: AGENT_OWNER, agentId: 10388n, amount: 1_980_000n }]);
});

test("contest with 1, 2 and 3 winners splits the net evenly and the remainder goes to the first winner", () => {
  const entries = [
    entry(0n, OTHER, false),
    entry(0n, WORKER, true),
    entry(10388n, THIRD, true),
    entry(0n, POSTER, true),
  ];
  const three = classifyNadJob(job({ contest: true, resolved: true, reward: 1_000_001n }, Completed, entries), ctx);
  assert.equal(three.fee, 10_000n);
  assert.deepEqual(
    three.payouts.map((p) => [p.owner, p.agentId, p.amount]),
    [
      [WORKER, 0n, 330_001n],
      [AGENT_OWNER, 10388n, 330_000n],
      [POSTER, 0n, 330_000n],
    ],
  );
  assert.equal(three.netPaid, 990_001n);

  // Only entry 1 of the first two is awarded: it takes the whole net.
  const sole = classifyNadJob(
    job({ contest: true, resolved: true, reward: USDC }, Completed, entries.slice(0, 2)),
    ctx,
  );
  assert.deepEqual(
    sole.payouts.map((p) => p.amount),
    [990_000n],
  );
  const pair = classifyNadJob(
    job({ contest: true, resolved: true, reward: USDC }, Completed, [entry(0n, WORKER, true), entry(0n, OTHER, true)]),
    ctx,
  );
  assert.deepEqual(
    pair.payouts.map((p) => p.amount),
    [495_000n, 495_000n],
  );
});

test("resolved alone is not enough: the escrow status decides paid versus refunded", () => {
  const resolved = { isTaken: true, resolved: true, submittedResultHash: "ipfs://result", assignedProvider: WORKER };
  assert.equal(classifyNadJob(job(resolved, Completed), ctx).outcome, "paid");
  const refunded = classifyNadJob(job(resolved, Rejected), ctx);
  assert.equal(refunded.outcome, "refunded");
  assert.equal(refunded.netPaid, 0n);
  assert.equal(refunded.fee, 0n);
  assert.deepEqual(refunded.payouts, []);
  // A resolved job whose escrow still holds the money is reported as such, not guessed.
  assert.equal(classifyNadJob(job(resolved, Funded), ctx).outcome, "unclassified");
  assert.equal(classifyNadJob(job(resolved, Submitted), ctx).outcome, "unclassified");
  assert.equal(classifyNadJob(job(resolved, 9), ctx).outcome, "unclassified");
});

test("refunds: cancelled before work, refunded after rejection, expired when a taker vanished", () => {
  // Never taken, never funded in the escrow: cancelBounty or expireBounty paid the poster back from the adapter.
  assert.equal(classifyNadJob(job({ resolved: true }, Open), ctx).outcome, "cancelled");
  // Contest without entries: rejected in the escrow.
  assert.equal(classifyNadJob(job({ contest: true, resolved: true }, Rejected), ctx).outcome, "cancelled");
  // Contest with entries but no award: rejectAllContestEntries -> finalizeContestRejection.
  assert.equal(
    classifyNadJob(job({ contest: true, resolved: true }, Rejected, [entry(0n, WORKER, false)]), ctx).outcome,
    "refunded",
  );
  // Rejection finalized or dispute won by the poster.
  assert.equal(classifyNadJob(paidSingleWith(Rejected), ctx).outcome, "refunded");
  // expireBounty on a bounty that was taken but never submitted.
  assert.equal(
    classifyNadJob(job({ isTaken: true, resolved: true, assignedProvider: WORKER }, Rejected), ctx).outcome,
    "expired",
  );
});
test("arbitrator timeout is a fee-free 50/50 split with the odd unit to the worker", () => {
  const r = classifyNadJob(paidSingle({ reward: 1_000_001n, disputeRulingHash: ARBITRATOR_TIMEOUT_RULING }), ctx);
  assert.equal(r.outcome, "split");
  assert.equal(r.fee, 0n);
  assert.equal(r.netPaid, 500_001n);
  assert.equal(nadOutcomeLabel(r.outcome), "Settled");
});

test("an expired escrow (reconcileExpiredEscrow) pays no fee and follows the contract's branches", () => {
  const taken = { isTaken: true, resolved: true, assignedProvider: WORKER };
  const submitted = { ...taken, submittedResultHash: "ipfs://result" };
  assert.equal(classifyNadJob(job(taken, Expired), ctx).outcome, "expired");
  const silent = classifyNadJob(job(submitted, Expired), ctx);
  assert.equal(silent.outcome, "paid");
  assert.equal(silent.fee, 0n);
  assert.equal(silent.netPaid, USDC);
  assert.equal(classifyNadJob(job({ ...submitted, rejectedAt: 5n }, Expired), ctx).outcome, "expired");
  const answered = classifyNadJob(
    job({ ...submitted, disputeRaisedAt: 5n, disputeResponseHash: "ipfs://r", reward: 1_000_001n }, Expired),
    ctx,
  );
  assert.equal(answered.outcome, "split");
  assert.equal(answered.netPaid, 500_001n);
  const workerWins = classifyNadJob(job({ ...submitted, disputeRaisedAt: 5n, disputeByWorker: true }, Expired), ctx);
  assert.equal(workerWins.outcome, "paid");
  assert.equal(workerWins.netPaid, USDC);
  assert.equal(classifyNadJob(job({ ...submitted, disputeRaisedAt: 5n }, Expired), ctx).outcome, "expired");
  // Contest recovered through the expired escrow: the whole reward is split, no fee.
  const contest = classifyNadJob(
    job({ contest: true, resolved: true }, Expired, [entry(0n, WORKER, true), entry(0n, OTHER, true)]),
    ctx,
  );
  assert.equal(contest.outcome, "paid");
  assert.equal(contest.fee, 0n);
  assert.deepEqual(
    contest.payouts.map((p) => p.amount),
    [500_000n, 500_000n],
  );
});

test("unresolved single-taker bounties: open, in progress and expired", () => {
  const cases: [Partial<NadStatsMeta>, number, string][] = [
    [{}, Open, "open"],
    [{ deadline: NOW }, Open, "open"], // takeBounty still works at the exact deadline
    [{ deadline: NOW - 1n }, Open, "expired"],
    [{ isTaken: true }, Funded, "in_progress"],
    [{ isTaken: true, deadline: NOW - 1n }, Funded, "expired"], // taken, never submitted, waiting for expireBounty
    [{ isTaken: true, submittedResultHash: "x", deadline: NOW - DAY }, Submitted, "in_progress"],
    [{ isTaken: true, submittedResultHash: "x", rejectedAt: 5n }, Submitted, "in_progress"],
    [{ isTaken: true, submittedResultHash: "x", inDispute: true }, Submitted, "in_progress"],
    [{}, Expired, "expired"],
  ];
  for (const [m, status, outcome] of cases)
    assert.equal(
      classifyNadJob(job(m, status), ctx).outcome,
      outcome,
      JSON.stringify(m, (_, v) => (typeof v === "bigint" ? String(v) : v)),
    );
});

test("unresolved contests: open until full or past the deadline, then in review", () => {
  const base = { contest: true, maxEntries: 2 };
  const one = [entry(0n, WORKER, false)];
  const two = [entry(0n, WORKER, false), entry(0n, OTHER, false)];
  assert.equal(classifyNadJob(job(base, Funded), ctx).outcome, "open");
  assert.equal(classifyNadJob(job(base, Submitted, one), ctx).outcome, "open");
  assert.equal(classifyNadJob(job(base, Submitted, two), ctx).outcome, "in_progress"); // full
  assert.equal(classifyNadJob(job({ ...base, deadline: NOW }, Submitted, one), ctx).outcome, "in_progress");
  assert.equal(classifyNadJob(job({ ...base, deadline: NOW }, Funded), ctx).outcome, "expired"); // closed, no entries
  assert.equal(classifyNadJob(job({ ...base, rejectedAt: 5n }, Submitted, one), ctx).outcome, "in_progress");
  assert.equal(
    classifyNadJob(job({ ...base, rejectedAt: 5n, inDispute: true }, Submitted, one), ctx).outcome,
    "in_progress",
  );
});

// The five jobs on the Monad mainnet demo: a paid bounty, a paid contest, a cancelled contest and two open bounties.
const demo = (): NadJobSnapshot[] => [
  paidSingle({ jobId: 1n, agentId: 10388n, assignedProvider: WORKER }),
  job({ jobId: 2n, contest: true, resolved: true, reward: 2n * USDC, maxEntries: 2 }, Completed, [
    entry(10388n, WORKER, true),
  ]),
  job({ jobId: 3n, contest: true, resolved: true, maxEntries: 1 }, Rejected),
  job({ jobId: 4n }, Open),
  job({ jobId: 5n }, Open),
];

test("report for the mainnet demo set", () => {
  const { stats, leaderboard, recentlySettled } = buildNadStatsReport(demo(), ctx);
  assert.deepEqual(stats, {
    posted: 5,
    open: 2,
    inProgress: 0,
    settledPaid: 2,
    refunded: 1,
    expired: 0,
    unclassified: 0,
    postedUsdc: "6",
    openUsdc: "2",
    paidOutUsdc: "2.97",
    feesUsdc: "0.03",
    uniquePosters: 1,
    uniquePaidIdentities: 1,
  });
  assert.deepEqual(leaderboard, [{ owner: AGENT_OWNER, agentId: 10388, paidJobs: 2, usdcEarned: "2.97" }]);
  assert.deepEqual(recentlySettled, [
    {
      jobId: 2,
      kind: "contest",
      outcome: "paid",
      reward: "2",
      netPaid: "1.98",
      fee: "0.02",
      ownerPaid: AGENT_OWNER,
      agentId: 10388,
      payouts: [{ owner: AGENT_OWNER, agentId: 10388, usdc: "1.98" }],
      resolvedAtUnknown: true,
    },
    {
      jobId: 1,
      kind: "single",
      outcome: "paid",
      reward: "1",
      netPaid: "0.99",
      fee: "0.01",
      ownerPaid: AGENT_OWNER,
      agentId: 10388,
      payouts: [{ owner: AGENT_OWNER, agentId: 10388, usdc: "0.99" }],
      resolvedAtUnknown: true,
    },
  ]);
});

test("leaderboard orders by paid jobs, then USDC earned, then identity, and merges one identity across jobs", () => {
  const jobs = [
    // human A: 1 job, 5 USDC
    paidSingle({ jobId: 1n, reward: 5n * USDC, assignedProvider: WORKER }),
    // agent 10388: 2 jobs, 2 USDC total gross
    paidSingle({ jobId: 2n, agentId: 10388n, assignedProvider: OTHER }),
    paidSingle({ jobId: 3n, agentId: 10388n, assignedProvider: THIRD }), // another working wallet, same identity
    // human B: 2 jobs, 4 USDC gross -> beats the agent on earnings at equal job count
    paidSingle({ jobId: 4n, reward: 2n * USDC, assignedProvider: POSTER }),
    paidSingle({ jobId: 5n, reward: 2n * USDC, assignedProvider: POSTER.toLowerCase() }), // same wallet, other casing
    // refunded and open jobs never appear
    paidSingleWith(Rejected),
    job({ jobId: 7n }, Open),
  ];
  const { leaderboard, stats } = buildNadStatsReport(jobs, ctx);
  assert.deepEqual(
    leaderboard.map((r) => [r.agentId, r.paidJobs, r.usdcEarned]),
    [
      [0, 2, "3.96"],
      [10388, 2, "1.98"],
      [0, 1, "4.95"],
    ],
  );
  assert.equal(leaderboard[0].owner, POSTER);
  assert.equal(leaderboard[1].owner, AGENT_OWNER);
  assert.equal(leaderboard[2].owner, WORKER);
  assert.equal(stats.uniquePaidIdentities, 3);
});

test("an exact tie is broken by identity so the order is stable", () => {
  const a = paidSingle({ jobId: 1n, assignedProvider: THIRD });
  const b = paidSingle({ jobId: 2n, assignedProvider: OTHER });
  const forward = buildNadStatsReport([a, b], ctx).leaderboard.map((r) => r.owner);
  const reverse = buildNadStatsReport([b, a], ctx).leaderboard.map((r) => r.owner);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward, [OTHER, THIRD]);
});

test("unique counts: posters ignore address casing, identities are agents or wallets", () => {
  const jobs = [
    paidSingle({ jobId: 1n, poster: POSTER, agentId: 10388n }),
    paidSingle({ jobId: 2n, poster: POSTER.toLowerCase(), agentId: 10388n }),
    paidSingle({ jobId: 3n, poster: OTHER, assignedProvider: WORKER }),
    job({ jobId: 4n, poster: THIRD }, Open),
  ];
  const { stats } = buildNadStatsReport(jobs, ctx);
  assert.equal(stats.posted, 4);
  assert.equal(stats.uniquePosters, 3);
  assert.equal(stats.uniquePaidIdentities, 2);
});

test("limits cap the recent list (newest job id first) and the leaderboard", () => {
  const jobs = Array.from({ length: 6 }, (_, i) =>
    paidSingle({ jobId: BigInt(i + 1), assignedProvider: `0x${(i + 1).toString(16).padStart(40, "0")}` }),
  );
  const { recentlySettled, leaderboard, stats } = buildNadStatsReport(jobs, ctx, {
    recentLimit: 3,
    leaderboardLimit: 2,
  });
  assert.deepEqual(
    recentlySettled.map((r) => r.jobId),
    [6, 5, 4],
  );
  assert.equal(leaderboard.length, 2);
  assert.equal(stats.settledPaid, 6);
  assert.equal(stats.uniquePaidIdentities, 6);
});

test("empty input and nonexistent jobs yield an all-zero report", () => {
  const zero = {
    posted: 0,
    open: 0,
    inProgress: 0,
    settledPaid: 0,
    refunded: 0,
    expired: 0,
    unclassified: 0,
    postedUsdc: "0",
    openUsdc: "0",
    paidOutUsdc: "0",
    feesUsdc: "0",
    uniquePosters: 0,
    uniquePaidIdentities: 0,
  };
  assert.deepEqual(buildNadStatsReport([], ctx), { stats: zero, leaderboard: [], recentlySettled: [] });
  // A zero poster means the id was never created.
  assert.deepEqual(buildNadStatsReport([job({ poster: ZERO_ADDRESS }, Open)], ctx).stats, zero);
});

test("the fee defaults to 100 bps and an owner lookup is optional", () => {
  const r = classifyNadJob(paidSingle({ agentId: 5n }), { nowSec: NOW });
  assert.equal(r.fee, 10_000n);
  assert.equal(r.payouts[0].owner, ZERO_ADDRESS);
  assert.equal(nadOutcomeLabel("open"), "Open");
  assert.equal(nadOutcomeLabel("unclassified"), "Unknown");
});

// ─── Link-preview text helpers (app/bounty/[jobId]/nadCard.ts) ─────────────────────────────────────────────────
// nadCard imports the chain config, which is chosen by env at module load, so it is imported after setting the
// Monad network.
process.env.NEXT_PUBLIC_ARC_NETWORK = "monad-mainnet";
const loadCard = () => import("../app/bounty/[jobId]/nadCard");

test("preview text: the post form's JSON gives the title and the rest of the description, never the encryption key", async () => {
  const { parseDescription } = await loadCard();
  const raw = JSON.stringify({
    version: 1,
    title: "Write a haiku",
    description: "Write a haiku\n\nAbout **Monad** and its [docs](https://example.test/docs).\n- one\n- two",
    contestEncryption: { version: 1, publicKey: "SECRET-KEY-MATERIAL", keySource: "mera-prf-v1" },
  });
  const parsed = parseDescription(raw);
  assert.equal(parsed.title, "Write a haiku");
  assert.equal(parsed.body, "About Monad and its docs. one two");
  assert.ok(!JSON.stringify(parsed).includes("SECRET"));
});

test("preview text: launch-demo pins use name, plain markdown uses its first line, junk falls back to nothing", async () => {
  const { parseDescription } = await loadCard();
  assert.deepEqual(
    parseDescription(
      '{"name":"NadBounty mainnet demo: single","description":"Launch demonstration on Monad mainnet with real USDC."}',
    ),
    { title: "NadBounty mainnet demo: single", body: "Launch demonstration on Monad mainnet with real USDC." },
  );
  assert.deepEqual(parseDescription("# Fix the parser\n\nIt crashes on empty input."), {
    title: "Fix the parser",
    body: "It crashes on empty input.",
  });
  assert.deepEqual(parseDescription("Just one line"), { title: "Just one line", body: "" });
  assert.deepEqual(parseDescription('{"title":5,"description":{"a":1}}'), { title: "", body: "" });
  assert.deepEqual(parseDescription(""), { title: "", body: "" });
});

test("preview text: markup is stripped and long text is cut on code points with three dots", async () => {
  const { plainText, clip } = await loadCard();
  assert.equal(plainText("<b>bold</b> ![pic](u.png) `code` text\n\n\tmore"), "bold code text more");
  assert.equal(clip("short", 10), "short");
  assert.equal(clip("a".repeat(200), 160).length, 160);
  assert.ok(clip("a".repeat(200), 160).endsWith("..."));
  assert.equal(clip("😀".repeat(20), 10), `${"😀".repeat(7)}...`);
  assert.equal(clip("word ".repeat(40), 20), "word word word...");
  assert.equal(clip("supercalifragilistic expialidocious", 20), "supercalifragilis...");
});
