import test from "node:test";
import assert from "node:assert/strict";
import { NAD_SETTLEMENTS } from "../lib/nadKeeper";
import { DEPOSIT_EXPLAINER, MIN_WORKER_BOND, WORKER_BOND_BPS } from "../lib/nadMoney";
import {
  DEFAULT_SCORE,
  approveBlocker,
  averageText,
  cancelBlocker,
  challengeBlocker,
  contestClosedAtView,
  deadlineInfo,
  estimateChainNow,
  gateFails,
  parseScore,
  payContestBlocker,
  rejectAllBlocker,
  rejectBlocker,
  replaceEntryBlocker,
  respondBlocker,
  settlementText,
  submitWorkBlocker,
  textIntent,
  timeLeftText,
  workerBlocker,
  type WorkerCheck,
  type WorkerMeta,
} from "../lib/nadActions";
// En dash and em dash, built from code points so this file itself holds neither character.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const T = 1_800_000_000n;
const DAY = 86400n;
const HOUR = 3600n;
const ZERO = "0x0000000000000000000000000000000000000000";
const ME = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";

test("chain clock estimate adds whole real seconds since the block was read and never goes backwards", () => {
  assert.equal(estimateChainNow(T, 1_000, 1_000), T);
  assert.equal(estimateChainNow(T, 1_000, 3_999), T + 2n);
  assert.equal(estimateChainNow(T, 1_000, 31_000), T + 30n);
  assert.equal(estimateChainNow(T, 5_000, 1_000), T);
});

test("contestClosedAt mirrors the contract view: stored closure wins, the deadline closes it otherwise", () => {
  assert.equal(contestClosedAtView(0n, T + 100n, T), 0n);
  assert.equal(contestClosedAtView(0n, T + 100n, T + 100n), T + 100n);
  assert.equal(contestClosedAtView(0n, T + 100n, T + 500n), T + 100n);
  assert.equal(contestClosedAtView(T - 5n, T + 100n, T), T - 5n);
});

test("time left text", () => {
  assert.equal(timeLeftText(T + 2n * DAY + 4n * HOUR + 30n, T), "2d 4h");
  assert.equal(timeLeftText(T + 5n * HOUR + 10n * 60n, T), "5h 10m");
  assert.equal(timeLeftText(T + 12n * 60n, T), "12m");
  assert.equal(timeLeftText(T + 59n, T), "under a minute");
});

test("the deadline label and every deadline-gated button read the same clock, with the contract's boundaries", () => {
  const single = { contest: false, deadline: T, resolved: false };
  // takeBounty / submitWork allow block.timestamp <= deadline: the deadline second itself is still open.
  assert.deepEqual(deadlineInfo(single, T - 1n), { passed: false, label: "under a minute left" });
  assert.equal(deadlineInfo(single, T).passed, false);
  assert.deepEqual(deadlineInfo(single, T + 1n), { passed: true, label: "Deadline passed" });
  // A contest is closed from block.timestamp >= deadline.
  const contest = { contest: true, deadline: T, resolved: false };
  assert.equal(deadlineInfo(contest, T - 1n).passed, false);
  assert.deepEqual(deadlineInfo(contest, T), { passed: true, label: "Entries closed" });
  // Closed early (every slot filled): closed even though the deadline is far away.
  assert.deepEqual(deadlineInfo({ ...contest, deadline: T + 9n * DAY }, T, T - 60n), {
    passed: true,
    label: "Entries closed",
  });
  assert.deepEqual(deadlineInfo({ ...single, resolved: true }, T - 1_000n), { passed: true, label: "Settled" });
  assert.equal(deadlineInfo({ ...single, deadline: T + 3n * DAY + 2n * HOUR }, T).label, "3d 2h left");
});

test("every permissionless settlement has a sentence, none of them shows a function name or a dash", () => {
  const contexts = [true, false].flatMap((contest) =>
    [true, false].flatMap((isTaken) => [true, false].map((disputeByWorker) => ({ contest, isTaken, disputeByWorker }))),
  );
  for (const settlement of NAD_SETTLEMENTS) {
    for (const ctx of contexts) {
      const { button, description } = settlementText(settlement, ctx);
      assert.ok(button.length > 10 && description.length > 30, settlement);
      assert.doesNotMatch(button, /[a-z][A-Z]/, `${settlement}: ${button}`); // camelCase = a raw function name
      assert.doesNotMatch(button + description, DASHES, settlement);
      assert.doesNotMatch(button, new RegExp(settlement), settlement);
    }
  }
});

test("settlement wording follows the contract", () => {
  const c = { contest: false, isTaken: true, disputeByWorker: true };
  assert.equal(settlementText("autoApprove", c).button, "Release payment to the worker (review window passed)");
  assert.equal(settlementText("expireBounty", c).button, "Refund the poster (deadline passed)");
  assert.equal(settlementText("finalizeRejection", c).button, "Finalize rejection and refund the poster");
  assert.equal(settlementText("claimDefaultRuling", c).button, "Apply default ruling (poster did not respond)");
  assert.equal(
    settlementText("claimDefaultRuling", { ...c, disputeByWorker: false }).button,
    "Apply default ruling (worker did not respond)",
  );
  assert.equal(settlementText("claimArbitratorTimeout", c).button, "Arbitrator timed out: split 50/50");
  // Money details that matter: who is paid, whether the 1% fee applies.
  assert.match(settlementText("autoApprove", c).description, /1% fee/);
  assert.match(settlementText("autoApprove", c).description, /scored 80/);
  assert.match(settlementText("claimArbitratorTimeout", c).description, /No fee/);
  assert.match(settlementText("reconcileExpiredEscrow", c).description, /No fee/);
  assert.match(settlementText("settleContestSilence", { ...c, contest: true }).description, /all entries/);
  assert.match(settlementText("claimDefaultRuling", c).description, /worker wins by default/);
  assert.match(
    settlementText("claimDefaultRuling", { ...c, disputeByWorker: false }).description,
    /poster wins by default/,
  );
  assert.match(settlementText("expireBounty", { ...c, contest: true }).button, /no entries/);
});

test("the text box label follows the stage and the role", () => {
  const base = { poster: false, contest: false, inDispute: false, rejectedAt: 0n, disputeByWorker: true };
  const label = (o: Partial<typeof base>) => textIntent({ ...base, ...o }).label;
  assert.equal(label({}), "Your result");
  assert.equal(label({ contest: true }), "Your result");
  assert.equal(label({ poster: true }), "Reason for rejection");
  assert.equal(label({ poster: true, inDispute: true }), "Your response");
  assert.equal(label({ rejectedAt: 5n }), "Evidence for your challenge");
  assert.equal(label({ rejectedAt: 5n, inDispute: true }), "Evidence for your challenge");
  assert.equal(label({ inDispute: true, disputeByWorker: false }), "Your response");
  assert.equal(label({ inDispute: true, disputeByWorker: true }), "Your result");
  assert.match(textIntent({ ...base, contest: true }).hint, /Encrypted/);
  assert.match(textIntent(base).hint, /plain text/);
});

test("score input: whole numbers 0-100 only, default 90", () => {
  assert.equal(DEFAULT_SCORE, 90);
  for (const ok of ["0", "90", "100", " 55 ", "007"])
    assert.deepEqual(parseScore(ok), { ok: true, value: Number(ok.trim()) });
  for (const bad of ["", " ", "101", "-1", "9.5", "ninety", "1e2", "1000", "NaN", "0x10"]) {
    const result = parseScore(bad);
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.match(result.error, /0 to 100/);
  }
});

test("gate arithmetic equals BountyAdapterV48._checkGate", () => {
  // [minJobs, minAvg, jobs, scoreSum, fails]
  const rows: Array<[bigint, number, bigint, bigint, boolean]> = [
    [0n, 0, 0n, 0n, false],
    [3n, 80, 3n, 240n, false],
    [3n, 80, 3n, 239n, true],
    [3n, 80, 2n, 200n, true],
    [3n, 80, 10n, 801n, false],
    [10n, 90, 10n, 899n, true],
    [10n, 90, 10n, 900n, false],
    [0n, 80, 0n, 0n, true], // an average is required but there are no jobs
    [0n, 80, 1n, 80n, false],
    [0n, 80, 1n, 79n, true],
    [3n, 0, 3n, 0n, false],
  ];
  for (const [minJobs, minAvg, jobs, sum, fails] of rows) {
    assert.equal(gateFails(minJobs, minAvg, jobs, sum), fails, `${minJobs}/${minAvg} vs ${jobs}/${sum}`);
  }
  assert.equal(averageText(0n, 0n), "no average yet");
  assert.equal(averageText(3n, 250n), "an average of 83.33");
  assert.equal(averageText(1n, 90n), "an average of 90");
});

const workerMeta = (o: Partial<WorkerMeta> = {}): WorkerMeta => ({
  contest: true,
  deadline: T + 5n * DAY,
  resolved: false,
  isTaken: false,
  agentOnly: false,
  humanOnly: false,
  whitelistedProvider: ZERO as `0x${string}`,
  requireWorkerBond: false,
  reward: 5_000_000n,
  maxEntries: 3,
  minJobs: 0n,
  minAvgScore: 0,
  ...o,
});
type CheckInput = Omit<Partial<WorkerCheck>, "meta"> & { meta?: Partial<WorkerMeta> };
const check = (o: CheckInput = {}): WorkerCheck => ({
  mode: "enter",
  now: T,
  paused: false,
  closedAt: 0n,
  entries: [],
  agentCount: 0,
  identity: { agentId: 0n, wallet: ME, controlled: true },
  ...o,
  meta: workerMeta(o.meta),
});

test("entering a contest: the first reason wins, in the contract's order", () => {
  const rows: Array<[string, WorkerCheck, RegExp | null]> = [
    ["nothing in the way", check(), null],
    ["paused", check({ paused: true }), /Entries are paused/],
    ["settled", check({ meta: { resolved: true } }), /already settled/],
    [
      "full",
      check({ entries: [1, 2, 3].map((i) => ({ agentId: BigInt(i), entrant: OTHER })) }),
      /full: all 3 entry slots are taken/,
    ],
    ["deadline passed", check({ now: T + 5n * DAY }), /deadline has passed/],
    ["closed early", check({ closedAt: T - 5n }), /has closed/],
    ["agents only, human identity, no agents", check({ meta: { agentOnly: true } }), /Register an agent/],
    [
      "agents only, human identity, has agents",
      check({ meta: { agentOnly: true }, agentCount: 2 }),
      /Choose one of your agents/,
    ],
    [
      "humans only, agent identity",
      check({ meta: { humanOnly: true }, identity: { agentId: 4n, wallet: ME, controlled: true } }),
      /humans only/,
    ],
    [
      "agent not controlled",
      check({ identity: { agentId: 4n, wallet: ME, controlled: false } }),
      /does not control agent #4/,
    ],
    [
      "reserved wallet",
      check({ meta: { whitelistedProvider: OTHER as `0x${string}` } }),
      /reserved for one specific wallet/,
    ],
    [
      "reserved wallet, agent whose owner is someone else",
      check({
        meta: { whitelistedProvider: OTHER as `0x${string}` },
        identity: { agentId: 4n, wallet: ME, controlled: true, owner: ME },
      }),
      /reserved for one specific wallet/,
    ],
    [
      "reserved wallet with an agent whose owner was not read: the contract decides",
      check({
        meta: { whitelistedProvider: OTHER as `0x${string}` },
        identity: { agentId: 4n, wallet: ME, controlled: true },
      }),
      null,
    ],
    [
      "reserved wallet matches the agent owner",
      check({
        meta: { whitelistedProvider: OTHER as `0x${string}` },
        identity: { agentId: 4n, wallet: ME, controlled: true, owner: OTHER },
      }),
      null,
    ],
    [
      "already entered as the same human",
      check({ entries: [{ agentId: 0n, entrant: ME.toUpperCase().replace("0X", "0x") }] }),
      /already entered/,
    ],
    [
      "already entered as the same agent from another wallet",
      check({ entries: [{ agentId: 4n, entrant: OTHER }], identity: { agentId: 4n, wallet: ME, controlled: true } }),
      /already entered/,
    ],
    ["a different human entered, that is fine", check({ entries: [{ agentId: 0n, entrant: OTHER }] }), null],
    [
      "gate not met",
      check({ meta: { minJobs: 3n, minAvgScore: 80 }, gate: { jobs: 1n, sum: 90n } }),
      /Needs 3\+ paid jobs and an 80\+ average\. This identity has 1 paid job and an average of 90\./,
    ],
    ["gate met", check({ meta: { minJobs: 3n, minAvgScore: 80 }, gate: { jobs: 4n, sum: 340n } }), null],
    ["gate unknown: the contract decides", check({ meta: { minJobs: 3n, minAvgScore: 80 }, gate: null }), null],
    [
      "a gate with zero jobs",
      check({ meta: { minJobs: 0n, minAvgScore: 70 }, gate: { jobs: 0n, sum: 0n } }),
      /no average yet/,
    ],
  ];
  for (const [name, input, expected] of rows) {
    const reason = workerBlocker(input);
    if (expected === null) assert.equal(reason, null, name);
    else assert.match(reason ?? "", expected, name);
  }
});

test("taking a single bounty", () => {
  const take = (o: CheckInput = {}) => check({ mode: "take", ...o, meta: { contest: false, ...o.meta } });
  assert.equal(workerBlocker(take()), null);
  assert.match(workerBlocker(take({ paused: true })) ?? "", /Taking bounties is paused/);
  assert.match(workerBlocker(take({ meta: { isTaken: true } })) ?? "", /already took/);
  // takeBounty allows block.timestamp <= deadline.
  assert.equal(workerBlocker(take({ now: T + 5n * DAY })), null);
  assert.match(workerBlocker(take({ now: T + 5n * DAY + 1n })) ?? "", /deadline has passed/);
  // A deposit bounty needs 12 hours left.
  const bond = { requireWorkerBond: true };
  assert.equal(workerBlocker(take({ meta: bond, now: T + 5n * DAY - 12n * HOUR })), null);
  assert.match(workerBlocker(take({ meta: bond, now: T + 5n * DAY - 12n * HOUR + 1n })) ?? "", /at least 12 hours/);
  // The refundable deposit is max(0.50 USDC, 15%) = 0.75 USDC for a 5 USDC reward.
  assert.match(
    workerBlocker(take({ meta: bond, usdcBalance: 700_000n })) ?? "",
    /You need 0\.75 USDC for the refundable deposit; your wallet has 0\.7 USDC/,
  );
  assert.equal(workerBlocker(take({ meta: bond, usdcBalance: 750_000n })), null);
  assert.equal(workerBlocker(take({ meta: bond, usdcBalance: null })), null);
  assert.equal(workerBlocker(take({ usdcBalance: 0n })), null);
});

test("poster and worker blockers", () => {
  const m = {
    contest: false,
    resolved: false,
    isTaken: true,
    inDispute: false,
    rejectedAt: 0n,
    submittedResultHash: "ipfs://r",
    submittedAt: T,
    disputeByWorker: true,
    disputeRaisedAt: 0n,
    disputeResponseHash: "",
    winners: 1,
  };
  assert.equal(approveBlocker(m), null);
  assert.match(approveBlocker({ ...m, submittedResultHash: "" }) ?? "", /not submitted/);
  assert.match(approveBlocker({ ...m, inDispute: true }) ?? "", /in a dispute/);
  assert.match(approveBlocker({ ...m, rejectedAt: 1n }) ?? "", /rejected this work/);
  assert.match(approveBlocker({ ...m, resolved: true }) ?? "", /already settled/);
  // approve has no deadline; reject stops after 14 days.
  assert.equal(approveBlocker(m), null);
  assert.equal(rejectBlocker(m, T + 14n * DAY), null);
  assert.match(rejectBlocker(m, T + 14n * DAY + 1n) ?? "", /14-day review window has ended/);

  assert.match(cancelBlocker(m, 0) ?? "", /Someone already took/);
  assert.equal(cancelBlocker({ ...m, isTaken: false }, 0), null);
  assert.match(cancelBlocker({ ...m, isTaken: false, contest: true }, 2) ?? "", /already has entries/);
  assert.equal(cancelBlocker({ ...m, isTaken: false, contest: true }, 0), null);

  const c = { ...m, contest: true, isTaken: false, winners: 2, submittedResultHash: "" };
  assert.equal(payContestBlocker(c, "pickContestWinners", 1), null);
  assert.match(payContestBlocker(c, "pickContestWinners", 0) ?? "", /Select at least one winner/);
  assert.match(payContestBlocker(c, "pickContestWinners", 3) ?? "", /at most 2 winners/);
  assert.match(payContestBlocker({ ...c, rejectedAt: 4n }, null, 1) ?? "", /rejected all entries/);
  assert.match(payContestBlocker(c, null, 1) ?? "", /review window has ended/);
  assert.match(payContestBlocker({ ...c, winners: 1 }, "pickContestWinners", 2) ?? "", /at most 1 winner\./);

  assert.equal(rejectAllBlocker(c, 3, T, T + 14n * DAY), null);
  assert.match(rejectAllBlocker(c, 3, T, T + 14n * DAY + 1n) ?? "", /review window has ended/);
  assert.match(rejectAllBlocker(c, 3, 0n, T) ?? "", /once the contest closes/);
  assert.match(rejectAllBlocker(c, 0, T, T) ?? "", /no entries/);
  assert.match(rejectAllBlocker({ ...c, rejectedAt: 1n }, 3, T, T) ?? "", /already rejected/);

  // Single dispute: only the respondent (the poster when the worker opened it) can reply, within 48 hours.
  const d = { ...m, inDispute: true, disputeRaisedAt: T };
  assert.equal(respondBlocker(d, T + 48n * HOUR, []), null);
  assert.match(respondBlocker(d, T + 48n * HOUR + 1n, []) ?? "", /48-hour reply window has ended/);
  assert.match(respondBlocker({ ...d, disputeResponseHash: "x" }, T, []) ?? "", /already replied/);
  assert.match(respondBlocker({ ...d, disputeByWorker: false }, T, []) ?? "", /worker has to reply/);
  // Contest challenges: each one has its own 48 hours.
  const cd = { ...c, inDispute: true, rejectedAt: T, disputeRaisedAt: T + HOUR };
  const open = [{ challengedAt: T + HOUR, respondedAt: 0n }];
  assert.equal(respondBlocker(cd, T + HOUR + 48n * HOUR, open), null);
  assert.match(respondBlocker(cd, T + HOUR + 48n * HOUR + 1n, open) ?? "", /window to answer a challenge has ended/);
  assert.match(
    respondBlocker(cd, T, [{ challengedAt: T + HOUR, respondedAt: T + 2n * HOUR }]) ?? "",
    /already answered every challenge/,
  );

  const rejected = { resolved: false, rejectedAt: T, inDispute: false, contest: false };
  assert.equal(challengeBlocker(rejected, T + 48n * HOUR, false), null);
  assert.match(challengeBlocker(rejected, T + 48n * HOUR + 1n, false) ?? "", /48-hour challenge window has ended/);
  assert.match(challengeBlocker({ ...rejected, inDispute: true }, T, false) ?? "", /already challenged/);
  assert.equal(challengeBlocker({ ...rejected, inDispute: true, contest: true }, T, false), null);
  assert.match(challengeBlocker({ ...rejected, contest: true }, T, true) ?? "", /already challenged/);
  assert.match(challengeBlocker({ ...rejected, rejectedAt: 0n }, T, false) ?? "", /no rejection/);

  const w = { resolved: false, deadline: T + DAY, submittedResultHash: "" };
  assert.equal(submitWorkBlocker(w, T + DAY), null);
  assert.match(submitWorkBlocker(w, T + DAY + 1n) ?? "", /deadline has passed/);
  assert.match(submitWorkBlocker({ ...w, submittedResultHash: "x" }, T) ?? "", /already submitted/);

  assert.equal(replaceEntryBlocker(false, 0n), null);
  assert.match(replaceEntryBlocker(true, 0n) ?? "", /paused/);
  assert.match(replaceEntryBlocker(false, T) ?? "", /contest has closed/);
});

test("no blocker text contains an en or em dash", () => {
  const texts = [
    workerBlocker(check({ paused: true })),
    workerBlocker(check({ meta: { agentOnly: true } })),
    approveBlocker({
      contest: false,
      resolved: false,
      isTaken: true,
      inDispute: true,
      rejectedAt: 0n,
      submittedResultHash: "x",
      submittedAt: 0n,
      disputeByWorker: true,
      disputeRaisedAt: 0n,
      disputeResponseHash: "",
      winners: 1,
    }),
    replaceEntryBlocker(false, T),
  ];
  for (const text of texts) assert.doesNotMatch(text ?? "", DASHES);
});

test("the deposit tooltip states the contract's constants", () => {
  assert.equal(WORKER_BOND_BPS, 1500n);
  assert.equal(MIN_WORKER_BOND, 500_000n);
  assert.equal(
    DEPOSIT_EXPLAINER,
    "The worker locks a refundable 15% deposit (at least 0.50 USDC) to take this bounty.",
  );
});
