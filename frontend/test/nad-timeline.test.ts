import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AC_EXPIRY_BUFFER,
  APPROVAL_TIMEOUT,
  ARBITRATOR_TIMEOUT,
  DAY,
  DISPUTE_RESPONSE_WINDOW,
  HOUR,
  REJECTION_CHALLENGE_WINDOW,
  buildTimeline,
  currentPhase,
  describeWindow,
  formatRelative,
  phaseWhenText,
  timelineRules,
  type PhaseId,
  type TimelineMeta,
} from "../lib/nadTimeline";

const T0 = 1_800_000_000n;
const meta = (overrides: Partial<TimelineMeta> = {}): TimelineMeta => ({
  contest: false,
  deadline: T0 + 7n * DAY,
  resolved: false,
  inDispute: false,
  isTaken: false,
  submittedAt: 0n,
  rejectedAt: 0n,
  disputeRaisedAt: 0n,
  disputeResponseHash: "",
  disputeByWorker: true,
  ...overrides,
});
const summary = (phases: ReturnType<typeof buildTimeline>) => phases.map((p) => `${p.id}:${p.state}`);
const byId = (phases: ReturnType<typeof buildTimeline>, id: PhaseId) => phases.find((p) => p.id === id)!;

test("the window constants equal the ones in BountyAdapterV48.sol", () => {
  const source = resolve(__dirname, "../../contracts/src/monad/BountyAdapterV48.sol");
  // The test runs from a frontend-only checkout too: the numbers are then checked against the documented values only.
  assert.equal(APPROVAL_TIMEOUT, 14n * 86400n);
  assert.equal(REJECTION_CHALLENGE_WINDOW, 48n * 3600n);
  assert.equal(DISPUTE_RESPONSE_WINDOW, 48n * 3600n);
  assert.equal(ARBITRATOR_TIMEOUT, 30n * 86400n);
  assert.equal(AC_EXPIRY_BUFFER, 90n * 86400n);
  if (!existsSync(source)) return;
  const text = readFileSync(source, "utf8");
  const read = (name: string) => new RegExp(`uint256 public constant ${name} = (\\d+) (hours|days);`).exec(text);
  const seconds = (name: string) => {
    const m = read(name);
    assert.ok(m, `${name} not found in the contract`);
    return BigInt(m[1]) * (m[2] === "days" ? 86400n : 3600n);
  };
  assert.equal(seconds("APPROVAL_TIMEOUT"), APPROVAL_TIMEOUT);
  assert.equal(seconds("REJECTION_CHALLENGE_WINDOW"), REJECTION_CHALLENGE_WINDOW);
  assert.equal(seconds("DISPUTE_RESPONSE_WINDOW"), DISPUTE_RESPONSE_WINDOW);
  assert.equal(seconds("ARBITRATOR_TIMEOUT"), ARBITRATOR_TIMEOUT);
  assert.equal(seconds("AC_EXPIRY_BUFFER"), AC_EXPIRY_BUFFER);
});

test("window descriptions are built from the constants", () => {
  assert.equal(describeWindow(14n * DAY), "14 days");
  assert.equal(describeWindow(DAY), "24 hours");
  assert.equal(describeWindow(3n * DAY), "3 days");
  assert.equal(describeWindow(48n * HOUR), "48 hours");
  assert.equal(describeWindow(HOUR), "1 hour");
  const rules = timelineRules().join("\n");
  assert.match(rules, /14 days/);
  assert.match(rules, /48 hours/);
  assert.match(rules, /30 days/);
  assert.match(rules, /90 days/);
});

test("relative time: future, past, and the minute floor", () => {
  assert.equal(formatRelative(T0 + 3n * DAY + 4n * HOUR + 59n, T0), "in 3d 4h");
  assert.equal(formatRelative(T0 - (5n * HOUR + 10n * 60n), T0), "5h 10m ago");
  assert.equal(formatRelative(T0 + 12n * 60n, T0), "in 12m");
  assert.equal(formatRelative(T0 - 2n * DAY, T0), "2d 0h ago");
  assert.equal(formatRelative(T0 + 59n, T0), "now");
  assert.equal(formatRelative(T0 - 59n, T0), "now");
  assert.equal(formatRelative(T0, T0), "now");
});

test("single taker nobody took: deadline is current, review waits, no escrow window", () => {
  const m = meta();
  const phases = buildTimeline(m, 0n, T0);
  assert.deepEqual(summary(phases), ["deadline:current", "review:upcoming"]);
  assert.equal(byId(phases, "deadline").end, m.deadline);
  assert.equal(byId(phases, "review").start, null);
  assert.equal(byId(phases, "review").end, null);
  assert.equal(byId(phases, "review").startsWhen, "when work is submitted");
  assert.equal(currentPhase(phases)?.id, "deadline");
});

test("single taker taken, not submitted: escrow recovery appears with its real date", () => {
  const m = meta({ isTaken: true });
  const phases = buildTimeline(m, 0n, T0 + DAY);
  assert.deepEqual(summary(phases), ["deadline:current", "review:upcoming", "recovery:upcoming"]);
  assert.equal(byId(phases, "recovery").start, m.deadline);
  assert.equal(byId(phases, "recovery").end, m.deadline + 90n * DAY);
});

test("single taker after the deadline with no submission: the first running clock is escrow recovery", () => {
  const m = meta({ isTaken: true });
  const phases = buildTimeline(m, 0n, m.deadline + 1n);
  assert.deepEqual(summary(phases), ["deadline:done", "review:upcoming", "recovery:current"]);
});

test("single taker submitted: review window runs 14 days from the submission", () => {
  const submittedAt = T0 + DAY;
  const m = meta({ isTaken: true, submittedAt });
  const phases = buildTimeline(m, 0n, submittedAt + 3n * DAY);
  assert.deepEqual(summary(phases), ["deadline:done", "review:current", "recovery:upcoming"]);
  assert.equal(byId(phases, "review").start, submittedAt);
  assert.equal(byId(phases, "review").end, submittedAt + APPROVAL_TIMEOUT);
});

test("single taker review window over: done, and recovery takes over once the deadline passed", () => {
  const submittedAt = T0;
  const m = meta({ isTaken: true, submittedAt, deadline: T0 + DAY });
  const afterReview = submittedAt + APPROVAL_TIMEOUT + 1n;
  const phases = buildTimeline(m, 0n, afterReview);
  assert.deepEqual(summary(phases), ["deadline:done", "review:done", "recovery:current"]);
});

test("single taker the review window ends exactly at 14 days (inclusive, as the contract allows approve until then)", () => {
  const m = meta({ isTaken: true, submittedAt: T0 });
  assert.equal(byId(buildTimeline(m, 0n, T0 + APPROVAL_TIMEOUT), "review").state, "current");
  assert.equal(byId(buildTimeline(m, 0n, T0 + APPROVAL_TIMEOUT + 1n), "review").state, "done");
});

test("single taker rejected: challenge window 48 hours from the rejection", () => {
  const submittedAt = T0;
  const rejectedAt = T0 + 2n * DAY;
  const m = meta({ isTaken: true, submittedAt, rejectedAt });
  const phases = buildTimeline(m, 0n, rejectedAt + HOUR);
  assert.deepEqual(summary(phases), ["deadline:done", "review:done", "rejection:current", "recovery:upcoming"]);
  assert.equal(byId(phases, "rejection").end, rejectedAt + 48n * HOUR);
  assert.equal(byId(buildTimeline(m, 0n, rejectedAt + 48n * HOUR + 1n), "rejection").state, "done");
});

test("single taker challenged: the poster's 48-hour reply window, then the 30-day arbitrator window", () => {
  const rejectedAt = T0 + DAY;
  const raised = rejectedAt + HOUR;
  const m = meta({
    isTaken: true,
    submittedAt: T0,
    rejectedAt,
    inDispute: true,
    disputeRaisedAt: raised,
    disputeByWorker: true,
  });
  const waiting = buildTimeline(m, 0n, raised + HOUR);
  assert.deepEqual(summary(waiting), [
    "deadline:done",
    "review:done",
    "rejection:done",
    "response:current",
    "arbitrator:upcoming",
    "recovery:upcoming",
  ]);
  assert.equal(byId(waiting, "response").label, "Poster response window");
  assert.equal(byId(waiting, "response").end, raised + 48n * HOUR);
  assert.equal(byId(waiting, "arbitrator").end, raised + 30n * DAY);
  // The poster replied: only the arbitrator is left.
  const replied = buildTimeline({ ...m, disputeResponseHash: "ipfs://reply" }, 0n, raised + HOUR);
  assert.equal(byId(replied, "response").state, "done");
  assert.equal(byId(replied, "arbitrator").state, "current");
  // Silence for 48 hours: the default ruling is open, the arbitrator window is the clock still running.
  const silent = buildTimeline(m, 0n, raised + 48n * HOUR + 1n);
  assert.equal(byId(silent, "response").state, "done");
  assert.equal(byId(silent, "arbitrator").state, "current");
  // After 30 days the arbitrator window is over too.
  const late = buildTimeline(m, 0n, raised + 30n * DAY + 1n);
  assert.equal(byId(late, "arbitrator").state, "done");
});

test("a dispute opened by the poster names the worker as the one who must reply", () => {
  const m = meta({
    isTaken: true,
    submittedAt: T0,
    inDispute: true,
    disputeRaisedAt: T0 + DAY,
    disputeByWorker: false,
  });
  const phases = buildTimeline(m, 0n, T0 + DAY + HOUR);
  assert.equal(byId(phases, "response").label, "Worker response window");
  assert.match(byId(phases, "response").note, /^The worker/);
});

test("contest still taking entries", () => {
  const m = meta({ contest: true });
  const phases = buildTimeline(m, 0n, T0, { entryCount: 2 });
  assert.deepEqual(summary(phases), ["deadline:current", "review:upcoming", "recovery:upcoming"]);
  assert.equal(byId(phases, "deadline").label, "Entries close");
  assert.equal(byId(phases, "deadline").end, m.deadline);
  assert.equal(byId(phases, "review").end, null);
  assert.equal(byId(phases, "review").startsWhen, "when the contest closes");
});

test("contest filled early: entries closed at the fill time, review runs 14 days from then", () => {
  const m = meta({ contest: true });
  const closedAt = T0 + DAY;
  const phases = buildTimeline(m, closedAt, closedAt + HOUR, { entryCount: 10 });
  assert.deepEqual(summary(phases), ["deadline:done", "review:current", "recovery:upcoming"]);
  assert.equal(byId(phases, "deadline").end, closedAt);
  assert.match(byId(phases, "deadline").note, /closed early/);
  assert.equal(byId(phases, "review").start, closedAt);
  assert.equal(byId(phases, "review").end, closedAt + 14n * DAY);
});

test("contest closes by itself at the deadline even before anyone records it", () => {
  const m = meta({ contest: true });
  const phases = buildTimeline(m, 0n, m.deadline, { entryCount: 3 });
  assert.equal(byId(phases, "deadline").state, "done");
  assert.equal(byId(phases, "review").start, m.deadline);
  assert.equal(byId(phases, "review").state, "current");
  assert.equal(byId(buildTimeline(m, 0n, m.deadline - 1n, { entryCount: 3 }), "deadline").state, "current");
});

test("contest closed without entries has no review window", () => {
  const m = meta({ contest: true });
  const phases = buildTimeline(m, 0n, m.deadline + HOUR, { entryCount: 0 });
  assert.deepEqual(summary(phases), ["deadline:done", "recovery:current"]);
});

test("contest rejected and challenged: rejection window, then one reply window per challenge", () => {
  const closedAt = T0;
  const rejectedAt = T0 + 2n * DAY;
  const c1 = rejectedAt + HOUR;
  const c2 = rejectedAt + 10n * HOUR;
  const m = meta({ contest: true, rejectedAt, inDispute: true, disputeRaisedAt: c1 });
  const challenges = [
    { challengedAt: c1, respondedAt: 0n },
    { challengedAt: 0n, respondedAt: 0n },
    { challengedAt: c2, respondedAt: 0n },
  ];
  const phases = buildTimeline(m, closedAt, c2 + HOUR, { entryCount: 3, challenges });
  assert.deepEqual(summary(phases), [
    "deadline:done",
    "review:done",
    "rejection:current",
    "response:upcoming",
    "arbitrator:upcoming",
    "recovery:upcoming",
  ]);
  const response = byId(phases, "response");
  assert.equal(response.start, c1);
  // The earliest unanswered challenge sets the deadline.
  assert.equal(response.end, c1 + 48n * HOUR);
  // Rejection window over: the reply window is now the running clock.
  const later = buildTimeline(m, closedAt, rejectedAt + 48n * HOUR + 1n, { entryCount: 3, challenges });
  assert.equal(byId(later, "rejection").state, "done");
  assert.equal(byId(later, "response").state, "current");
  // Once the first challenge is answered the next unanswered one counts.
  const partly = buildTimeline(m, closedAt, c2 + HOUR, {
    entryCount: 3,
    challenges: [{ challengedAt: c1, respondedAt: c1 + 60n }, challenges[1], challenges[2]],
  });
  assert.equal(byId(partly, "response").end, c2 + 48n * HOUR);
  // Everything answered: the response window is done, the arbitrator window runs.
  const answered = buildTimeline(m, closedAt, rejectedAt + 48n * HOUR + 1n, {
    entryCount: 3,
    challenges: challenges.map((c) => (c.challengedAt > 0n ? { ...c, respondedAt: c.challengedAt + 60n } : c)),
  });
  assert.equal(byId(answered, "response").state, "done");
  assert.equal(byId(answered, "arbitrator").state, "current");
});

test("a rejected contest keeps the rejection window open for other entrants even after the first challenge", () => {
  const rejectedAt = T0 + DAY;
  const m = meta({ contest: true, rejectedAt, inDispute: true, disputeRaisedAt: rejectedAt + HOUR });
  const challenges = [{ challengedAt: rejectedAt + HOUR, respondedAt: 0n }];
  const phases = buildTimeline(m, T0, rejectedAt + 2n * HOUR, { entryCount: 2, challenges });
  assert.equal(byId(phases, "rejection").state, "current");
});

test("a resolved bounty has no current phase and no escrow recovery; the phases it went through are done", () => {
  const rejectedAt = T0 + DAY;
  const m = meta({ resolved: true, isTaken: true, submittedAt: T0, rejectedAt, deadline: T0 + 2n * DAY });
  const phases = buildTimeline(m, 0n, rejectedAt + 3n * DAY);
  assert.deepEqual(summary(phases), ["deadline:done", "review:done", "rejection:done", "settled:done"]);
  assert.equal(currentPhase(phases), null);
  // Cancelled a day in: the deadline (a week away) never came.
  const cancelled = buildTimeline(meta({ resolved: true }), 0n, T0 + DAY);
  assert.deepEqual(summary(cancelled), ["deadline:skipped", "settled:done"]);
  const settledContest = buildTimeline(meta({ contest: true, resolved: true }), T0, T0 + DAY, { entryCount: 3 });
  assert.deepEqual(summary(settledContest), ["deadline:done", "review:skipped", "settled:done"]);
});

test("a withdrawn rejection (rejectedAt back to 0) removes the rejection window", () => {
  const m = meta({ isTaken: true, submittedAt: T0, rejectedAt: 0n });
  assert.ok(!buildTimeline(m, 0n, T0 + HOUR).some((p) => p.id === "rejection"));
});

test("never more than one current phase, and phases keep their order, across a sweep of times and states", () => {
  const order: PhaseId[] = ["deadline", "review", "rejection", "response", "arbitrator", "recovery", "settled"];
  const metas: TimelineMeta[] = [
    meta(),
    meta({ isTaken: true }),
    meta({ isTaken: true, submittedAt: T0 + DAY }),
    meta({ isTaken: true, submittedAt: T0 + DAY, rejectedAt: T0 + 2n * DAY }),
    meta({
      isTaken: true,
      submittedAt: T0 + DAY,
      rejectedAt: T0 + 2n * DAY,
      inDispute: true,
      disputeRaisedAt: T0 + 3n * DAY,
    }),
    meta({ contest: true }),
    meta({ contest: true, rejectedAt: T0 + 9n * DAY, inDispute: true, disputeRaisedAt: T0 + 9n * DAY }),
    meta({ resolved: true, isTaken: true, submittedAt: T0 }),
    meta({ resolved: true }),
    meta({ resolved: true, contest: true }),
    meta({ resolved: true, isTaken: true, submittedAt: T0 + DAY, rejectedAt: T0 + 2n * DAY }),
    meta({
      resolved: true,
      isTaken: true,
      submittedAt: T0 + DAY,
      rejectedAt: T0 + 2n * DAY,
      disputeRaisedAt: T0 + 3n * DAY,
      disputeResponseHash: "ipfs://reply",
    }),
  ];
  for (const m of metas) {
    for (let day = -1; day <= 140; day += 1) {
      const now = T0 + BigInt(day) * DAY + 17n * 60n;
      for (const closedAt of [0n, T0 + 8n * DAY]) {
        const phases = buildTimeline(m, m.contest ? closedAt : 0n, now, {
          entryCount: 3,
          challenges: m.inDispute && m.contest ? [{ challengedAt: m.disputeRaisedAt, respondedAt: 0n }] : [],
        });
        assert.ok(phases.filter((p) => p.state === "current").length <= 1, `${day} ${JSON.stringify(summary(phases))}`);
        const indices = phases.map((p) => order.indexOf(p.id));
        assert.deepEqual(
          indices,
          [...indices].sort((a, b) => a - b),
        );
        for (const p of phases) {
          if (p.start !== null && p.end !== null) assert.ok(p.end > p.start || p.id === "deadline");
          // A done phase never carries an end date in the future; a skipped one only exists on a settled job.
          if (p.state === "done") assert.ok(p.end === null || p.end <= now, `${day} ${p.id} done, ends later`);
          if (p.state === "skipped") assert.ok(m.resolved, `${day} ${p.id} skipped on a live job`);
        }
        if (m.resolved) {
          assert.equal(phases[phases.length - 1].id, "settled");
          assert.ok(!phases.some((p) => p.id === "recovery" || p.state === "current" || p.state === "upcoming"));
        } else {
          assert.ok(!phases.some((p) => p.state === "skipped" || p.id === "settled"));
        }
      }
    }
  }
});

// ───────── settled jobs: no window is "done" with an end date in the future ─────────
type SettledRow = {
  name: string;
  meta: Partial<TimelineMeta>;
  closedAt?: bigint;
  now: bigint;
  options?: Parameters<typeof buildTimeline>[3];
  // phase id, expected state, expected end (undefined: not checked, null: no date)
  expected: Array<[PhaseId, string, bigint | null | undefined]>;
  settledAs?: string;
};
const rows: SettledRow[] = [
  {
    name: "contest settled early: the poster picked a winner a day after it closed",
    meta: { contest: true, resolved: true, deadline: T0 + 7n * DAY },
    closedAt: T0 + 2n * DAY,
    now: T0 + 3n * DAY,
    options: { entryCount: 4, settledAs: "Paid" },
    expected: [
      ["deadline", "done", T0 + 2n * DAY],
      ["review", "skipped", undefined],
      ["settled", "done", null],
    ],
    settledAs: "Paid",
  },
  {
    name: "single taker settled early: approved two days after the submission",
    meta: { resolved: true, isTaken: true, submittedAt: T0 + DAY, deadline: T0 + 7n * DAY },
    now: T0 + 3n * DAY,
    options: { settledAs: "Paid" },
    expected: [
      ["deadline", "done", T0 + DAY],
      ["review", "skipped", undefined],
      ["settled", "done", null],
    ],
    settledAs: "Paid",
  },
  {
    name: "expired then refunded: taken, never delivered, the deadline passed",
    meta: { resolved: true, isTaken: true, deadline: T0 + 2n * DAY },
    now: T0 + 5n * DAY,
    options: { settledAs: "Refunded to the poster" },
    expected: [
      ["deadline", "done", T0 + 2n * DAY],
      ["settled", "done", null],
    ],
    settledAs: "Refunded to the poster",
  },
  {
    name: "cancelled before the deadline: the deadline never came",
    meta: { resolved: true, deadline: T0 + 7n * DAY },
    now: T0 + DAY,
    expected: [
      ["deadline", "skipped", undefined],
      ["settled", "done", null],
    ],
  },
  {
    name: "contest cancelled before it closed",
    meta: { contest: true, resolved: true, deadline: T0 + 7n * DAY },
    now: T0 + DAY,
    options: { entryCount: 0 },
    expected: [
      ["deadline", "skipped", undefined],
      ["settled", "done", null],
    ],
  },
  {
    name: "rejected then challenged, then ruled on while the response and arbitrator windows were still open",
    meta: {
      resolved: true,
      isTaken: true,
      submittedAt: T0,
      rejectedAt: T0 + 2n * DAY,
      disputeRaisedAt: T0 + 3n * DAY,
      deadline: T0 + 5n * DAY,
    },
    now: T0 + 3n * DAY + HOUR,
    options: { settledAs: "Refunded to the poster" },
    expected: [
      ["deadline", "done", T0],
      // The poster rejected on day 2: the review window ended then, not on day 14.
      ["review", "done", T0 + 2n * DAY],
      // The worker challenged on day 3: the rejection window ended then.
      ["rejection", "done", T0 + 3n * DAY],
      // Day 3 + 48 hours and day 3 + 30 days are both still ahead of "now".
      ["response", "skipped", undefined],
      ["arbitrator", "skipped", undefined],
      ["settled", "done", null],
    ],
    settledAs: "Refunded to the poster",
  },
  {
    name: "rejected then challenged and answered: the reply ended the response window",
    meta: {
      resolved: true,
      isTaken: true,
      submittedAt: T0,
      rejectedAt: T0 + DAY,
      disputeRaisedAt: T0 + 2n * DAY,
      disputeResponseHash: "ipfs://reply",
      deadline: T0 + 3n * DAY,
    },
    now: T0 + 2n * DAY + HOUR,
    expected: [
      ["deadline", "done", T0],
      ["review", "done", T0 + DAY],
      ["rejection", "done", T0 + 2n * DAY],
      ["response", "done", null],
      ["arbitrator", "skipped", undefined],
      ["settled", "done", null],
    ],
  },
  {
    name: "contest rejected, challenged and answered, then settled before the arbitrator window ran out",
    meta: { contest: true, resolved: true, rejectedAt: T0 + 9n * DAY, disputeRaisedAt: T0 + 9n * DAY + HOUR },
    closedAt: T0 + 8n * DAY,
    now: T0 + 12n * DAY,
    options: {
      entryCount: 3,
      challenges: [{ challengedAt: T0 + 9n * DAY + HOUR, respondedAt: T0 + 9n * DAY + 5n * HOUR }],
    },
    expected: [
      ["deadline", "done", T0 + 8n * DAY],
      ["review", "done", T0 + 9n * DAY],
      ["rejection", "done", T0 + 9n * DAY + 48n * HOUR],
      ["response", "done", T0 + 9n * DAY + 5n * HOUR],
      ["arbitrator", "skipped", undefined],
      ["settled", "done", null],
    ],
  },
  {
    name: "resolved after the window: the poster stayed silent and the review window ran to its end",
    meta: { resolved: true, isTaken: true, submittedAt: T0, deadline: T0 + DAY },
    now: T0 + 15n * DAY,
    options: { settledAs: "Paid" },
    expected: [
      ["deadline", "done", T0],
      ["review", "done", T0 + 14n * DAY],
      ["settled", "done", null],
    ],
    settledAs: "Paid",
  },
  {
    name: "contest resolved after the review window (settled by silence)",
    meta: { contest: true, resolved: true, deadline: T0 + 7n * DAY },
    closedAt: T0 + 7n * DAY,
    now: T0 + 30n * DAY,
    options: { entryCount: 5 },
    expected: [
      ["deadline", "done", T0 + 7n * DAY],
      ["review", "done", T0 + 21n * DAY],
      ["settled", "done", null],
    ],
  },
];
for (const row of rows) {
  test(`settled timeline: ${row.name}`, () => {
    const phases = buildTimeline(meta(row.meta), row.closedAt ?? 0n, row.now, row.options);
    assert.deepEqual(
      phases.map((p) => p.id),
      row.expected.map(([id]) => id),
    );
    for (const [id, state, end] of row.expected) {
      const phase = byId(phases, id);
      assert.equal(phase.state, state, id);
      if (end !== undefined) assert.equal(phase.end, end, `${id} end`);
      // The rule behind the whole table.
      if (phase.state === "done") assert.ok(phase.end === null || phase.end <= row.now, `${id} done with a future end`);
    }
    assert.equal(currentPhase(phases), null);
    assert.equal(byId(phases, "settled").result, row.settledAs ?? "settled");
    for (const phase of phases.filter((p) => p.state === "skipped")) {
      assert.equal(phase.result, "not needed, settled early", phase.id);
    }
  });
}

test("the line next to a phase never pairs 'ended' with a future date", () => {
  const fmt = (ts: bigint) => `@${ts}`;
  const now = T0 + 2n * DAY;
  const settled = buildTimeline(meta({ contest: true, resolved: true }), T0 + DAY, now, {
    entryCount: 2,
    settledAs: "Paid",
  });
  const lines = Object.fromEntries(settled.map((p) => [p.id, phaseWhenText(p, now, fmt)]));
  assert.equal(lines.review, "not needed, settled early");
  assert.equal(lines.settled, "Paid");
  assert.match(lines.deadline, /^ended @\d+ · 1d 0h ago$/);
  // A live job shows "ends" for an open window and "ended" for a window that is over.
  const live = buildTimeline(meta({ isTaken: true, submittedAt: T0, deadline: T0 + DAY }), 0n, T0 + 3n * DAY);
  assert.match(phaseWhenText(byId(live, "review"), T0 + 3n * DAY, fmt), /^ends @\d+ · in 11d 0h$/);
  assert.match(phaseWhenText(byId(live, "deadline"), T0 + 3n * DAY, fmt), /^ended @\d+ · /);
  const waiting = buildTimeline(meta({ isTaken: true }), 0n, T0);
  assert.equal(phaseWhenText(byId(waiting, "review"), T0, fmt), "starts when work is submitted");
});

test("an unresolved job whose windows really ended still reads as ended, with past dates", () => {
  // Rejected, nobody challenged, the 48 hours are over: waiting for someone to finalize.
  const rejectedAt = T0 + DAY;
  const m = meta({ isTaken: true, submittedAt: T0, rejectedAt, deadline: T0 + 2n * DAY });
  const now = rejectedAt + 3n * DAY;
  const phases = buildTimeline(m, 0n, now);
  assert.deepEqual(summary(phases), ["deadline:done", "review:done", "rejection:done", "recovery:current"]);
  assert.equal(byId(phases, "review").end, rejectedAt);
  assert.equal(byId(phases, "rejection").end, rejectedAt + 48n * HOUR);
  for (const p of phases) if (p.state === "done") assert.ok(p.end !== null && p.end <= now);
});

test("work submitted ahead of the deadline reads as submitted, not as a deadline that has ended", () => {
  const m = meta({ isTaken: true, submittedAt: T0 + DAY, deadline: T0 + 7n * DAY });
  const deadline = byId(buildTimeline(m, 0n, T0 + 2n * DAY), "deadline");
  assert.equal(deadline.label, "Work submitted");
  assert.equal(deadline.state, "done");
  assert.equal(deadline.end, T0 + DAY);
});
