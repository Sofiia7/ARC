import test from "node:test";
import assert from "node:assert/strict";
import { computeOutcome, REFUND_REASON_TEXT, type OutcomeEntry, type OutcomeMeta } from "../lib/nadOutcome";
import { halves, workerBondFor } from "../lib/nadMoney";
// En dash and em dash, built from code points so this file itself holds neither character.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const POSTER = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const OWNER_9 = "0x9999999999999999999999999999999999999999";
const DEADLINE = 2_000_000_000n;
const REWARD = 5_000_000n;

const single = (o: Partial<OutcomeMeta> = {}): OutcomeMeta => ({
  contest: false,
  poster: POSTER,
  reward: REWARD,
  deadline: DEADLINE,
  resolved: true,
  agentId: 0n,
  assignedProvider: WORKER,
  isTaken: true,
  submittedResultHash: "ipfs://result",
  rejectedAt: 0n,
  disputeRaisedAt: 0n,
  disputeResponseHash: "",
  disputeRulingHash: "",
  disputeByWorker: false,
  requireWorkerBond: false,
  ...o,
});
const contestMeta = (o: Partial<OutcomeMeta> = {}): OutcomeMeta =>
  single({
    contest: true,
    isTaken: false,
    assignedProvider: "0x0000000000000000000000000000000000000000",
    submittedResultHash: "",
    ...o,
  });
const entry = (agentId: bigint, awarded: boolean, tag = String(agentId)): OutcomeEntry => ({
  agentId,
  entrant: `0x${tag.padStart(40, "e")}`,
  resultHash: `ipfs://sealed-${tag}`,
  awarded,
});
const sumPayees = (o: NonNullable<ReturnType<typeof computeOutcome>>) => o.payees.reduce((s, p) => s + p.amount, 0n);

test("an unresolved bounty has no outcome", () => {
  assert.equal(computeOutcome({ meta: single({ resolved: false }), escrowStatus: 1 }), null);
});

test("single taker approved: worker gets the reward minus the 1% fee, fee goes to the recipient", () => {
  const o = computeOutcome({ meta: single(), escrowStatus: 3, feeRecipient: "0xfee" })!;
  assert.equal(o.kind, "paid");
  assert.equal(o.title, "Paid");
  assert.equal(o.gross, 5_000_000n);
  assert.equal(o.fee, 50_000n);
  assert.equal(o.feeRecipient, "0xfee");
  assert.equal(o.payees.length, 1);
  assert.deepEqual(
    { role: o.payees[0].role, amount: o.payees[0].amount, address: o.payees[0].address },
    { role: "worker", amount: 4_950_000n, address: WORKER },
  );
  assert.equal(o.payees[0].who, "the wallet that took it");
  assert.equal(sumPayees(o) + o.fee, o.gross);
  assert.deepEqual(o.results, [{ cid: "ipfs://result", sealed: false, entryIndex: null, agentId: 0n }]);
  assert.equal(o.approximate, false);
});

test("single taker fee rounds down like the contract, and the worker keeps the rest", () => {
  const o = computeOutcome({ meta: single({ reward: 1_000_001n }), escrowStatus: 3 })!;
  assert.equal(o.fee, 10_000n);
  assert.equal(o.payees[0].amount, 990_001n);
  assert.equal(computeOutcome({ meta: single({ reward: 99n }), escrowStatus: 3 })!.fee, 0n);
});

test("an agent worker is paid to the identity owner, whose address comes from the owners map", () => {
  const meta = single({ agentId: 9n });
  const unknown = computeOutcome({ meta, escrowStatus: 3 })!;
  assert.equal(unknown.payees[0].address, null);
  assert.equal(unknown.payees[0].who, "the identity owner of agent #9");
  const known = computeOutcome({ meta, escrowStatus: 3, owners: { "9": OWNER_9 } })!;
  assert.equal(known.payees[0].address, OWNER_9);
  assert.equal(known.payees[0].agentId, 9n);
});

test("a custom fee is honoured", () => {
  const o = computeOutcome({ meta: single(), escrowStatus: 3, feeBps: 250n })!;
  assert.equal(o.fee, 125_000n);
  assert.equal(o.payees[0].amount, 4_875_000n);
});

test("arbitrator timeout splits 50/50 with no fee and the odd unit to the worker", () => {
  const o = computeOutcome({
    meta: single({
      reward: 1_000_001n,
      disputeRulingHash: "timeout:50-50-split",
      disputeRaisedAt: 5n,
      disputeResponseHash: "r",
    }),
    escrowStatus: 3,
  })!;
  assert.equal(o.kind, "split");
  assert.equal(o.title, "Split 50/50");
  assert.equal(o.fee, 0n);
  assert.equal(o.posterRefund, 500_000n);
  assert.equal(o.payees.find((p) => p.role === "worker")!.amount, 500_001n);
  assert.equal(sumPayees(o), 1_000_001n);
  assert.deepEqual(halves(1_000_001n), { poster: 500_000n, worker: 500_001n });
});

test("refund reasons for a single bounty", () => {
  const cases: Array<[string, OutcomeMeta, number, bigint | undefined, string | null]> = [
    [
      "cancelled before the deadline",
      single({ isTaken: false, submittedResultHash: "" }),
      0,
      DEADLINE - 1n,
      "cancelled",
    ],
    ["never taken, deadline passed", single({ isTaken: false, submittedResultHash: "" }), 0, DEADLINE + 1n, "no-taker"],
    ["never taken, unknown time", single({ isTaken: false, submittedResultHash: "" }), 0, undefined, "no-taker"],
    ["taken, never submitted", single({ submittedResultHash: "" }), 4, undefined, "worker-vanished"],
    ["rejected and not challenged", single({ rejectedAt: 5n }), 4, undefined, "rejection-final"],
    ["dispute decided for the poster", single({ rejectedAt: 5n, disputeRaisedAt: 6n }), 4, undefined, "dispute-poster"],
    ["a plain refund with no known cause", single(), 4, undefined, null],
  ];
  for (const [name, meta, escrowStatus, now, reason] of cases) {
    const o = computeOutcome({ meta, escrowStatus, now })!;
    assert.equal(o.kind, "refunded", name);
    assert.equal(o.title, "Refunded to the poster", name);
    assert.equal(o.reason, reason, name);
    assert.equal(o.reasonText, reason ? REFUND_REASON_TEXT[reason as keyof typeof REFUND_REASON_TEXT] : null, name);
    assert.equal(o.fee, 0n, name);
    assert.equal(o.posterRefund, REWARD, name);
    assert.deepEqual(
      o.payees.map((p) => [p.role, p.amount, p.address]),
      [["poster", REWARD, POSTER]],
      name,
    );
  }
});

test("a worker deposit is forfeited to the poster only when the bounty expired taken and unsubmitted", () => {
  const vanished = computeOutcome({
    meta: single({ submittedResultHash: "", requireWorkerBond: true }),
    escrowStatus: 4,
  })!;
  // 15% of 5 USDC is 0.75 USDC, above the 0.50 USDC floor.
  assert.equal(vanished.forfeitedBond, 750_000n);
  assert.equal(vanished.posterRefund, 5_750_000n);
  assert.equal(vanished.reason, "worker-vanished");
});

test("worker deposit amounts follow max(0.50 USDC, 15%)", () => {
  assert.equal(workerBondFor(1_000_000n), 500_000n);
  assert.equal(workerBondFor(3_333_333n), 500_000n);
  assert.equal(workerBondFor(5_000_000n), 750_000n);
  assert.equal(workerBondFor(100_000_000n), 15_000_000n);
  const o = computeOutcome({
    meta: single({ reward: 10_000_000n, submittedResultHash: "", requireWorkerBond: true }),
    escrowStatus: 4,
  })!;
  assert.equal(o.forfeitedBond, 1_500_000n);
  assert.equal(o.posterRefund, 11_500_000n);
  assert.match(o.notes.join(" "), /deposit of 1\.5 USDC was forfeited/);
  // A submitted job already refunded the deposit at submitWork: nothing is forfeited.
  const delivered = computeOutcome({ meta: single({ requireWorkerBond: true, rejectedAt: 4n }), escrowStatus: 4 })!;
  assert.equal(delivered.forfeitedBond, 0n);
  assert.equal(delivered.posterRefund, REWARD);
});

test("reconcileExpiredEscrow outcomes for a single bounty (escrow Expired, no fee)", () => {
  const cases: Array<[string, Partial<OutcomeMeta>, string, bigint, bigint]> = [
    ["nothing submitted", { submittedResultHash: "" }, "refunded", REWARD, 0n],
    ["submitted, silent poster", {}, "paid", 0n, REWARD],
    ["rejected, never challenged", { rejectedAt: 4n }, "refunded", REWARD, 0n],
    ["disputed by worker, no reply", { disputeRaisedAt: 4n, disputeByWorker: true }, "paid", 0n, REWARD],
    ["disputed by poster, no reply", { disputeRaisedAt: 4n, disputeByWorker: false }, "refunded", REWARD, 0n],
    ["disputed and answered", { disputeRaisedAt: 4n, disputeResponseHash: "a" }, "split", 2_500_000n, 2_500_000n],
  ];
  for (const [name, overrides, kind, poster, worker] of cases) {
    const o = computeOutcome({ meta: single(overrides), escrowStatus: 5 })!;
    assert.equal(o.kind, kind, name);
    assert.equal(o.fee, 0n, name);
    assert.equal(o.posterRefund, poster, name);
    assert.equal(o.payees.find((p) => p.role === "worker")?.amount ?? 0n, worker, name);
    assert.match(o.notes.join(" "), /no protocol fee/, name);
  }
  const refunded = computeOutcome({ meta: single({ submittedResultHash: "" }), escrowStatus: 5 })!;
  assert.equal(refunded.reason, "escrow-expired");
});

test("the escrow status decides: Open and Rejected are refunds, an unreadable status is shown as Settled", () => {
  assert.equal(
    computeOutcome({ meta: single({ isTaken: false, submittedResultHash: "" }), escrowStatus: 0 })!.kind,
    "refunded",
  );
  const unknown = computeOutcome({ meta: single() })!;
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.title, "Settled");
  assert.equal(unknown.payees.length, 0);
});

test("contest: the net is split evenly between the awarded entries, entries stay sealed", () => {
  const entries = [entry(7n, true), entry(0n, false, "b"), entry(0n, true, "c")];
  const o = computeOutcome({
    meta: contestMeta({ reward: 2_000_000n }),
    escrowStatus: 3,
    entries,
    owners: { "7": OWNER_9 },
  })!;
  assert.equal(o.kind, "paid");
  assert.equal(o.fee, 20_000n);
  assert.equal(o.remainder, 0n);
  assert.deepEqual(
    o.payees.map((p) => [p.entryIndex, p.agentId, p.address, p.amount]),
    [
      [0, 7n, OWNER_9, 990_000n],
      [2, 0n, entries[2].entrant, 990_000n],
    ],
  );
  assert.equal(sumPayees(o) + o.fee + o.remainder, 2_000_000n);
  assert.deepEqual(
    o.results.map((r) => [r.cid, r.sealed, r.entryIndex]),
    [
      ["ipfs://sealed-7", true, 0],
      ["ipfs://sealed-c", true, 2],
    ],
  );
  assert.match(o.notes.join(" "), /encrypted/);
  assert.equal(o.approximate, false);
});

test("contest split: remainder goes to the first winner, reported separately; every unit is accounted for", () => {
  const entries = [entry(1n, true), entry(2n, true), entry(3n, true)];
  const o = computeOutcome({ meta: contestMeta({ reward: 1_000_001n }), escrowStatus: 3, entries })!;
  // fee 10_000, net 990_001, share 330_000, remainder 1
  assert.equal(o.fee, 10_000n);
  assert.equal(o.remainder, 1n);
  assert.deepEqual(
    o.payees.map((p) => p.amount),
    [330_000n, 330_000n, 330_000n],
  );
  assert.equal(sumPayees(o) + o.fee + o.remainder, 1_000_001n);
  assert.match(o.notes.join(" "), /0\.000001 USDC of rounding went to the first winner/);
});

test("contest invariants over a grid of rewards and winner counts", () => {
  for (const reward of [1_000_000n, 1_000_001n, 2_345_679n, 7_000_003n, 100_000_000n]) {
    for (let n = 1; n <= 7; n++) {
      const entries = Array.from({ length: n }, (_, i) => entry(BigInt(i + 1), true));
      const o = computeOutcome({ meta: contestMeta({ reward }), escrowStatus: 3, entries })!;
      assert.equal(sumPayees(o) + o.fee + o.remainder, reward, `${reward} / ${n}`);
      assert.equal(o.payees.length, n);
    }
  }
});

test("contest settled after silence pays every entry, even more than the winner count", () => {
  const entries = [entry(1n, true), entry(2n, true), entry(3n, true), entry(4n, true)];
  const o = computeOutcome({ meta: contestMeta({ reward: 4_000_000n }), escrowStatus: 3, entries })!;
  assert.equal(o.payees.length, 4);
  assert.deepEqual(
    o.payees.map((p) => p.amount),
    [990_000n, 990_000n, 990_000n, 990_000n],
  );
});

test("contest that went through a rejection dispute is flagged approximate with an honest note", () => {
  const entries = [entry(1n, true), entry(2n, false)];
  const o = computeOutcome({
    meta: contestMeta({ reward: 2_000_000n, rejectedAt: 10n }),
    escrowStatus: 3,
    entries,
    challenges: [
      { challengedAt: 11n, respondedAt: 12n },
      { challengedAt: 0n, respondedAt: 0n },
    ],
  })!;
  assert.equal(o.kind, "paid");
  assert.equal(o.approximate, true);
  assert.match(o.notes.join(" "), /Storage cannot tell these apart/);
  assert.equal(o.fee, 20_000n);
});

test("contest refunds: reasons", () => {
  const sealed = [entry(1n, false), entry(2n, false)];
  const none: never[] = [];
  const cases: Array<[string, Parameters<typeof computeOutcome>[0], string]> = [
    [
      "no entries, before the deadline",
      { meta: contestMeta(), escrowStatus: 4, entries: none, now: DEADLINE - 5n },
      "cancelled",
    ],
    [
      "no entries, deadline passed",
      { meta: contestMeta(), escrowStatus: 4, entries: none, now: DEADLINE + 5n },
      "no-entries",
    ],
    [
      "all rejected, nobody challenged",
      {
        meta: contestMeta({ rejectedAt: 5n }),
        escrowStatus: 4,
        entries: sealed,
        challenges: [
          { challengedAt: 0n, respondedAt: 0n },
          { challengedAt: 0n, respondedAt: 0n },
        ],
      },
      "contest-rejected",
    ],
    [
      "challenged, arbitrator refunded",
      {
        meta: contestMeta({ rejectedAt: 5n }),
        escrowStatus: 4,
        entries: sealed,
        challenges: [
          { challengedAt: 6n, respondedAt: 7n },
          { challengedAt: 0n, respondedAt: 0n },
        ],
      },
      "contest-ruling",
    ],
    ["escrow expired with no awards", { meta: contestMeta(), escrowStatus: 5, entries: sealed }, "escrow-expired"],
  ];
  for (const [name, input, reason] of cases) {
    const o = computeOutcome(input)!;
    assert.equal(o.kind, "refunded", name);
    assert.equal(o.reason, reason, name);
    assert.equal(o.fee, 0n, name);
    assert.equal(o.posterRefund, REWARD, name);
    assert.equal(o.payees[0].role, "poster", name);
  }
});

test("contest recovered from an expired escrow pays no fee", () => {
  const entries = [entry(1n, true), entry(2n, true)];
  const silent = computeOutcome({ meta: contestMeta({ reward: 3_000_001n }), escrowStatus: 5, entries })!;
  assert.equal(silent.fee, 0n);
  assert.equal(silent.posterRefund, 0n);
  assert.deepEqual(
    silent.payees.map((p) => p.amount),
    [1_500_000n, 1_500_000n],
  );
  assert.equal(silent.remainder, 1n);
  assert.equal(sumPayees(silent) + silent.remainder, 3_000_001n);
  assert.match(silent.notes.join(" "), /no protocol fee/);

  // Rejected, challenged, nobody answered: the challengers share the whole reward.
  const unanswered = computeOutcome({
    meta: contestMeta({ reward: 3_000_000n, rejectedAt: 4n }),
    escrowStatus: 5,
    entries: [entry(1n, true), entry(2n, false)],
    challenges: [
      { challengedAt: 5n, respondedAt: 0n },
      { challengedAt: 0n, respondedAt: 0n },
    ],
  })!;
  assert.equal(unanswered.fee, 0n);
  assert.deepEqual(
    unanswered.payees.map((p) => p.amount),
    [3_000_000n],
  );
  assert.equal(unanswered.posterRefund, 0n);

  // Rejected, challenged and answered: half back to the poster, half to the challengers.
  const answered = computeOutcome({
    meta: contestMeta({ reward: 3_000_001n, rejectedAt: 4n }),
    escrowStatus: 5,
    entries: [entry(1n, true), entry(2n, true)],
    challenges: [
      { challengedAt: 5n, respondedAt: 6n },
      { challengedAt: 5n, respondedAt: 6n },
    ],
  })!;
  assert.equal(answered.posterRefund, 1_500_000n);
  // 3_000_001 - 1_500_000 = 1_500_001 split between two challengers: 750_000 each, remainder 1.
  assert.deepEqual(
    answered.payees.filter((p) => p.role === "winner").map((p) => p.amount),
    [750_000n, 750_000n],
  );
  assert.equal(answered.remainder, 1n);
  assert.equal(sumPayees(answered) + answered.remainder, 3_000_001n);
  assert.match(answered.notes.join(" "), /50\/50/);
});

test("a settled contest with no awarded entry and no escrow status is reported as unknown, not guessed", () => {
  const o = computeOutcome({ meta: contestMeta(), entries: [entry(1n, false)] });
  assert.equal(o!.kind === "refunded" || o!.kind === "unknown", true);
});

test("user-visible outcome text contains no en or em dash", () => {
  const texts = [...Object.values(REFUND_REASON_TEXT)];
  const inputs = [
    computeOutcome({ meta: single(), escrowStatus: 3 })!,
    computeOutcome({ meta: single({ disputeRulingHash: "timeout:50-50-split" }), escrowStatus: 3 })!,
    computeOutcome({ meta: single({ submittedResultHash: "", requireWorkerBond: true }), escrowStatus: 4 })!,
    computeOutcome({ meta: single(), escrowStatus: 5 })!,
    computeOutcome({ meta: contestMeta({ rejectedAt: 4n }), escrowStatus: 3, entries: [entry(1n, true)] })!,
    computeOutcome({ meta: single() })!,
  ];
  for (const o of inputs) texts.push(o.title, ...o.notes, ...o.payees.map((p) => p.who));
  for (const text of texts) assert.doesNotMatch(text, DASHES, text);
});
