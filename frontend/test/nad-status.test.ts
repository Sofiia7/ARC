import test from "node:test";
import assert from "node:assert/strict";
import {
  GATES,
  GATE_PARAMS,
  KNOWN_CATS,
  gateRequirement,
  nadStatus,
  nadTitleOf,
  reconcileShare,
  resolutionOf,
  type Meta,
  type NadStatusCtx,
} from "../lib/nadStatus";

const now = BigInt(Math.floor(Date.now() / 1000));
const DAY = 86400n;
const future = now + 10n * DAY;
const past = now - 10n * DAY;
// Only the fields nadStatus reads are set; the rest of the on-chain struct is irrelevant here.
const meta = (overrides: Partial<Meta> = {}): Meta =>
  ({
    deadline: future,
    resolved: false,
    inDispute: false,
    submittedResultHash: "",
    isTaken: false,
    contest: false,
    rejectedAt: 0n,
    disputeRaisedAt: 0n,
    disputeResponseHash: "",
    disputeRulingHash: "",
    disputeByWorker: false,
    ...overrides,
  }) as unknown as Meta;

test("settled: resolved and not in dispute wins over every other flag", () => {
  const s = nadStatus(meta({ resolved: true, submittedResultHash: "bafy-result", isTaken: true, deadline: past }));
  assert.deepEqual(s, { kind: "paid", label: "Settled" });
});

test("in dispute: reported even when the job is resolved, and wins over submitted and taken", () => {
  assert.deepEqual(nadStatus(meta({ inDispute: true, submittedResultHash: "bafy-result", isTaken: true })), {
    kind: "in-review",
    label: "In dispute",
  });
  assert.deepEqual(nadStatus(meta({ resolved: true, inDispute: true })), { kind: "in-review", label: "In dispute" });
});

test("submitted: a result hash wins over taken and over an expired deadline", () => {
  const s = nadStatus(meta({ submittedResultHash: "bafy-result", isTaken: true, deadline: past }));
  assert.deepEqual(s, { kind: "submitted", label: "Submitted" });
});

test("in progress: taken without a result, even after the deadline", () => {
  assert.deepEqual(nadStatus(meta({ isTaken: true })), { kind: "in-review", label: "In progress" });
  assert.deepEqual(nadStatus(meta({ isTaken: true, deadline: past })), { kind: "in-review", label: "In progress" });
});

test("expired: untaken, unsubmitted and past the deadline", () => {
  assert.deepEqual(nadStatus(meta({ deadline: past })), { kind: "expired", label: "Expired" });
  assert.deepEqual(nadStatus(meta({ deadline: now - 1n })), { kind: "expired", label: "Expired" });
});

test("open: untaken, unsubmitted and before the deadline", () => {
  assert.deepEqual(nadStatus(meta()), { kind: "open", label: "Open" });
});

test("title: a JSON title is trimmed and wins over the description", () => {
  const raw = JSON.stringify({ version: 1, title: "  Build a thing  ", description: "# Other\nbody" });
  assert.equal(nadTitleOf(raw), "Build a thing");
});

test("title: a long JSON title is cut to 100 characters without an ellipsis", () => {
  const title = nadTitleOf(JSON.stringify({ title: "a".repeat(150) }));
  assert.equal(title.length, 100);
  assert.equal(title, "a".repeat(100));
});

test("title: a blank JSON title falls back to the first description line", () => {
  const raw = JSON.stringify({ title: "   ", description: "\n\n## Fix the parser\nDetails follow." });
  assert.equal(nadTitleOf(raw), "Fix the parser");
});

test("title: JSON without a title uses the description, skipping empty lines", () => {
  assert.equal(nadTitleOf(JSON.stringify({ description: "\n  \nWrite the docs\nmore" })), "Write the docs");
});

test("title: a markdown heading loses its hashes and inline markup", () => {
  assert.equal(nadTitleOf("### **Fix** the `bug`_now_\nbody text"), "Fix the bugnow");
});

test("title: plain text and non-JSON braces use the first non-empty line", () => {
  assert.equal(nadTitleOf("  \n\n  Short title  \nSecond line"), "Short title");
  assert.equal(nadTitleOf("{not json\nsecond"), "{not json");
});

test("title: a long markdown title is cut to 100 characters plus an ellipsis, 100 exactly is kept", () => {
  const long = nadTitleOf(`# ${"b".repeat(120)}\nbody`);
  assert.equal(long, `${"b".repeat(100)}…`);
  assert.equal(long.length, 101);
  assert.equal(nadTitleOf("c".repeat(100)), "c".repeat(100));
});

test("title: empty input gives an empty title", () => {
  assert.equal(nadTitleOf(""), "");
  assert.equal(nadTitleOf("\n  \n"), "");
});

test("categories and reputation gates match what the post form submits", () => {
  assert.deepEqual([...KNOWN_CATS].sort(), ["content", "data", "design", "dev", "other"]);
  assert.deepEqual(GATES, {
    Anyone: "all",
    "Proven: 3+ paid jobs, 80+ average": "proven",
    "Top: 10+ paid jobs, 90+ average": "top",
  });
  assert.deepEqual(GATE_PARAMS, {
    all: { minJobs: 0n, minAvgScore: 0 },
    proven: { minJobs: 3n, minAvgScore: 80 },
    top: { minJobs: 10n, minAvgScore: 90 },
  });
  assert.deepEqual(Object.values(GATES), Object.keys(GATE_PARAMS));
});

// ───────── states that need on-chain context ─────────
// AgenticCommerce.JobStatus: Open 0, Funded 1, Submitted 2, Completed 3, Rejected 4, Expired 5.
type Status = { kind: string; label: string };
const PAID: Status = { kind: "paid", label: "Paid" };
const SPLIT: Status = { kind: "paid", label: "Split 50/50" };
const REFUNDED: Status = { kind: "expired", label: "Refunded" };
const EXPIRED_REFUNDED: Status = { kind: "expired", label: "Expired and refunded" };
const SETTLED: Status = { kind: "paid", label: "Settled" };
const OPEN: Status = { kind: "open", label: "Open" };
const IN_REVIEW: Status = { kind: "in-review", label: "In review" };
const REJECTED: Status = { kind: "submitted", label: "Rejected" };
const DISPUTE: Status = { kind: "in-review", label: "In dispute" };
const EXPIRED: Status = { kind: "expired", label: "Expired" };

type Row = [name: string, overrides: Partial<Meta>, ctx: NadStatusCtx | undefined, expected: Status];
const resolvedRows: Row[] = [
  ["escrow completed -> Paid", { resolved: true, isTaken: true, submittedResultHash: "r" }, { escrowStatus: 3 }, PAID],
  [
    "escrow completed by the 30-day arbitrator timeout -> Split 50/50",
    { resolved: true, isTaken: true, submittedResultHash: "r", disputeRulingHash: "timeout:50-50-split" },
    { escrowStatus: 3 },
    SPLIT,
  ],
  [
    "a default ruling for the worker is still a normal payout",
    { resolved: true, isTaken: true, submittedResultHash: "r", disputeRulingHash: "default:no-response" },
    { escrowStatus: 3 },
    PAID,
  ],
  [
    "escrow rejected -> Refunded",
    { resolved: true, isTaken: true, submittedResultHash: "r", rejectedAt: 5n },
    { escrowStatus: 4 },
    REFUNDED,
  ],
  [
    "never taken, cancelled or expired (escrow job stayed Open) -> Refunded",
    { resolved: true },
    { escrowStatus: 0 },
    REFUNDED,
  ],
  [
    "escrow expired, nothing submitted -> Expired and refunded",
    { resolved: true, isTaken: true },
    { escrowStatus: 5 },
    EXPIRED_REFUNDED,
  ],
  [
    "escrow expired, submitted and never rejected -> the worker is paid (autoApprove replay)",
    { resolved: true, isTaken: true, submittedResultHash: "r" },
    { escrowStatus: 5 },
    PAID,
  ],
  [
    "escrow expired, submitted then rejected -> Expired and refunded",
    { resolved: true, isTaken: true, submittedResultHash: "r", rejectedAt: 9n },
    { escrowStatus: 5 },
    EXPIRED_REFUNDED,
  ],
  [
    "escrow expired, disputed by the worker, nobody replied -> the worker is paid",
    { resolved: true, isTaken: true, submittedResultHash: "r", disputeRaisedAt: 9n, disputeByWorker: true },
    { escrowStatus: 5 },
    PAID,
  ],
  [
    "escrow expired, disputed by the poster, nobody replied -> Expired and refunded",
    { resolved: true, isTaken: true, submittedResultHash: "r", disputeRaisedAt: 9n, disputeByWorker: false },
    { escrowStatus: 5 },
    EXPIRED_REFUNDED,
  ],
  [
    "escrow expired, disputed and answered -> Split 50/50",
    { resolved: true, isTaken: true, submittedResultHash: "r", disputeRaisedAt: 9n, disputeResponseHash: "answer" },
    { escrowStatus: 5 },
    SPLIT,
  ],
  [
    "contest, escrow expired, entries were awarded -> Paid",
    { resolved: true, contest: true },
    { escrowStatus: 5, anyAwarded: true },
    PAID,
  ],
  [
    "contest, escrow expired, nobody awarded -> Expired and refunded",
    { resolved: true, contest: true },
    { escrowStatus: 5, anyAwarded: false },
    EXPIRED_REFUNDED,
  ],
  ["contest completed -> Paid", { resolved: true, contest: true }, { escrowStatus: 3, anyAwarded: true }, PAID],
  [
    "contest rejected in the escrow -> Refunded",
    { resolved: true, contest: true },
    { escrowStatus: 4, anyAwarded: false },
    REFUNDED,
  ],
  ["contest awards without an escrow status -> Paid", { resolved: true, contest: true }, { anyAwarded: true }, PAID],
  [
    "cancelled contest with no award and no escrow status -> Refunded",
    { resolved: true, contest: true },
    { anyAwarded: false },
    REFUNDED,
  ],
  ["escrow status unknown -> the original Settled", { resolved: true }, {}, SETTLED],
  ["no context at all -> the original Settled", { resolved: true }, undefined, SETTLED],
  [
    "a single bounty with an unreadable escrow status stays Settled even when anyAwarded is false",
    { resolved: true },
    { anyAwarded: false },
    SETTLED,
  ],
];
for (const [name, overrides, ctx, expected] of resolvedRows) {
  test(`resolved: ${name}`, () => {
    assert.deepEqual(nadStatus(meta(overrides), ctx), expected);
  });
}

const liveRows: Row[] = [
  ["contest still taking entries", { contest: true }, { closedAt: 0n, entryCount: 3, nowSeconds: now }, OPEN],
  ["contest with no entries yet", { contest: true }, { closedAt: 0n, entryCount: 0, nowSeconds: now }, OPEN],
  [
    "contest closed with entries is in review",
    { contest: true },
    { closedAt: now - 5n, entryCount: 2, nowSeconds: now },
    IN_REVIEW,
  ],
  [
    "contest closed with no entries is expired",
    { contest: true },
    { closedAt: now - 5n, entryCount: 0, nowSeconds: now },
    EXPIRED,
  ],
  [
    "contest past its deadline counts as closed before any transaction records it",
    { contest: true, deadline: now - 1n },
    { closedAt: 0n, entryCount: 4, nowSeconds: now },
    IN_REVIEW,
  ],
  [
    "contest exactly at its deadline is closed (block.timestamp >= deadline)",
    { contest: true, deadline: now },
    { closedAt: 0n, entryCount: 4, nowSeconds: now },
    IN_REVIEW,
  ],
  [
    "contest one second before its deadline is open",
    { contest: true, deadline: now + 1n },
    { closedAt: 0n, entryCount: 4, nowSeconds: now },
    OPEN,
  ],
  [
    "contest closed and rejected is Rejected",
    { contest: true, rejectedAt: now - 60n },
    { closedAt: now - 120n, entryCount: 2, nowSeconds: now },
    REJECTED,
  ],
  [
    "contest challenged is In dispute",
    { contest: true, rejectedAt: now - 60n, inDispute: true },
    { closedAt: now - 120n, entryCount: 2, nowSeconds: now },
    DISPUTE,
  ],
  ["contest without ctx keeps the old reading: open before the deadline", { contest: true }, undefined, OPEN],
  [
    "contest without ctx keeps the old reading: expired after the deadline",
    { contest: true, deadline: past },
    undefined,
    EXPIRED,
  ],
  [
    "single taker, rejected, window open -> Rejected",
    { isTaken: true, submittedResultHash: "r", rejectedAt: now - 60n },
    undefined,
    REJECTED,
  ],
  [
    "single taker, submitted",
    { isTaken: true, submittedResultHash: "r" },
    { nowSeconds: now },
    { kind: "submitted", label: "Submitted" },
  ],
  ["single taker, taken", { isTaken: true }, { nowSeconds: now }, { kind: "in-review", label: "In progress" }],
  [
    "single taker, open at exactly the deadline (takeBounty allows block.timestamp <= deadline)",
    { deadline: now },
    { nowSeconds: now },
    OPEN,
  ],
  ["single taker, expired one second after the deadline", { deadline: now - 1n }, { nowSeconds: now }, EXPIRED],
  ["chain time wins over the local clock", { deadline: future }, { nowSeconds: future + 1n }, EXPIRED],
];
for (const [name, overrides, ctx, expected] of liveRows) {
  test(`unresolved: ${name}`, () => {
    assert.deepEqual(nadStatus(meta(overrides), ctx), expected);
  });
}

test("priority: in dispute > resolved > rejected > submitted > in progress > expired > open", () => {
  // Everything switched on at once, then removed from the top.
  const all: Partial<Meta> = {
    contest: false,
    resolved: true,
    inDispute: true,
    rejectedAt: 5n,
    submittedResultHash: "r",
    isTaken: true,
    deadline: past,
  };
  assert.equal(nadStatus(meta(all), { escrowStatus: 3 }).label, "In dispute");
  const step1 = { ...all, inDispute: false };
  assert.equal(nadStatus(meta(step1), { escrowStatus: 3 }).label, "Paid");
  const step2 = { ...step1, resolved: false };
  assert.equal(nadStatus(meta(step2)).label, "Rejected");
  const step3 = { ...step2, rejectedAt: 0n };
  assert.equal(nadStatus(meta(step3)).label, "Submitted");
  const step4 = { ...step3, submittedResultHash: "" };
  assert.equal(nadStatus(meta(step4)).label, "In progress");
  const step5 = { ...step4, isTaken: false };
  assert.equal(nadStatus(meta(step5)).label, "Expired");
  assert.equal(nadStatus(meta({ ...step5, deadline: future })).label, "Open");
  // A rejected contest that is also closed reads Rejected, not In review.
  assert.equal(
    nadStatus(meta({ contest: true, rejectedAt: 5n }), { closedAt: 3n, entryCount: 2, nowSeconds: now }).label,
    "Rejected",
  );
});

test("every status kind is one of the classes styled in globals.css", () => {
  const styled = new Set(["open", "submitted", "in-review", "paid", "expired"]);
  for (const [, overrides, ctx] of [...resolvedRows, ...liveRows]) {
    const status = nadStatus(meta(overrides), ctx);
    assert.ok(styled.has(status.kind), JSON.stringify(status));
  }
});

test("resolutionOf and reconcileShare follow the branches of reconcileExpiredEscrow", () => {
  const base = {
    submittedResultHash: "",
    disputeRaisedAt: 0n,
    disputeResponseHash: "",
    disputeByWorker: false,
    rejectedAt: 0n,
  };
  assert.equal(reconcileShare(base), "poster");
  assert.equal(reconcileShare({ ...base, submittedResultHash: "r" }), "worker");
  assert.equal(reconcileShare({ ...base, submittedResultHash: "r", rejectedAt: 1n }), "poster");
  assert.equal(reconcileShare({ ...base, submittedResultHash: "r", disputeRaisedAt: 1n }), "poster");
  assert.equal(
    reconcileShare({ ...base, submittedResultHash: "r", disputeRaisedAt: 1n, disputeByWorker: true }),
    "worker",
  );
  assert.equal(
    reconcileShare({ ...base, submittedResultHash: "r", disputeRaisedAt: 1n, disputeResponseHash: "a" }),
    "split",
  );
  assert.equal(
    resolutionOf({ ...base, contest: false, disputeRulingHash: "" }, { escrowStatus: 5 }),
    "expired-refunded",
  );
});

test("gate requirement wording", () => {
  assert.equal(gateRequirement(3n, 80), "Needs 3+ paid jobs and an 80+ average");
  assert.equal(gateRequirement(10n, 90), "Needs 10+ paid jobs and a 90+ average");
  assert.equal(gateRequirement(0n, 0), null);
  assert.equal(gateRequirement(5n, 0), "Needs 5+ paid jobs");
  assert.equal(gateRequirement(0n, 70), "Needs a 70+ average");
  assert.equal(gateRequirement(0n, 85), "Needs an 85+ average");
});

test("title: demo bounties pinned as { name, description } use the name", () => {
  const raw = JSON.stringify({ name: "  Mainnet demo bounty  ", description: "First line of the body\nmore" });
  assert.equal(nadTitleOf(raw), "Mainnet demo bounty");
});

test("title: title wins over name, name wins over the description, a blank one falls through", () => {
  const body = "## Body heading\ntext";
  assert.equal(nadTitleOf(JSON.stringify({ title: "From title", name: "From name", description: body })), "From title");
  assert.equal(nadTitleOf(JSON.stringify({ title: "   ", name: "From name", description: body })), "From name");
  assert.equal(nadTitleOf(JSON.stringify({ name: "From name", description: body })), "From name");
  assert.equal(nadTitleOf(JSON.stringify({ title: "", name: "  ", description: body })), "Body heading");
  assert.equal(nadTitleOf(JSON.stringify({ description: body })), "Body heading");
});

test("title: a name that is not text is ignored, and a long name is cut to 100 characters", () => {
  assert.equal(nadTitleOf(JSON.stringify({ name: 42, description: "Real title" })), "Real title");
  assert.equal(nadTitleOf(JSON.stringify({ name: { a: 1 }, title: ["x"], description: "Real title" })), "Real title");
  assert.equal(nadTitleOf(JSON.stringify({ name: "n".repeat(130) })), "n".repeat(100));
});
