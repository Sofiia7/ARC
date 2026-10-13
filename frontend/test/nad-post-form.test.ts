import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROX_GAS_PER_TX,
  CHOICE_CONTEST,
  CHOICE_SINGLE,
  CONTEST_CLOSING_HINT,
  KEY_CUSTODY_HINT,
  MAX_TAGS,
  costLines,
  failureNote,
  normalizeTag,
  parseRewardUnits,
  parseTags,
  planPostSteps,
  replan,
  stepText,
  validatePostForm,
  type PostFormValues,
} from "../lib/nadPostForm";
import { GATES, GATE_HINT } from "../lib/nadStatus";
// En dash and em dash, built from code points so this file itself holds neither character.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const form = (o: Partial<PostFormValues> = {}): PostFormValues => ({
  contest: true,
  description: "Build a small thing\n\nWith details.",
  reward: "5",
  days: "7",
  entries: "10",
  winners: "1",
  bond: false,
  tags: "",
  agentOnly: false,
  humanOnly: false,
  ...o,
});

test("tags: lowercase, trimmed, deduplicated, empty entries ignored", () => {
  assert.deepEqual(parseTags(""), { ok: true, tags: [] });
  assert.deepEqual(parseTags(" Design, Logo ,logo,, UI Kit "), { ok: true, tags: ["design", "logo", "ui-kit"] });
  assert.equal(normalizeTag("  Hello   World "), "hello-world");
});

test("tags: at most 10, each 1-32 characters (bytes, as the contract counts)", () => {
  const ten = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`).join(",");
  assert.equal(parseTags(ten).ok, true);
  const eleven = `${ten},extra`;
  const tooMany = parseTags(eleven);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.ok ? "" : tooMany.error, /at most 10 tags/);
  assert.equal(parseTags("a".repeat(32)).ok, true);
  const long = parseTags("a".repeat(33));
  assert.equal(long.ok, false);
  assert.match(long.ok ? "" : long.error, /1-32 characters/);
  // 11 two-byte characters = 22 bytes fine; 17 of them = 34 bytes too long, although only 17 characters.
  assert.equal(parseTags("é".repeat(16)).ok, true);
  assert.equal(parseTags("é".repeat(17)).ok, false);
  // Duplicates do not count towards the limit.
  assert.equal(parseTags(Array.from({ length: 20 }, () => "same").join(",")).ok, true);
});

test("reward text: exact decimals only, up to 6", () => {
  assert.equal(parseRewardUnits("5"), 5_000_000n);
  assert.equal(parseRewardUnits("2.5"), 2_500_000n);
  assert.equal(parseRewardUnits("0.000001"), 1n);
  assert.equal(parseRewardUnits(" 100 "), 100_000_000n);
  for (const bad of ["", ".", "-1", "1e3", "1,5", "1.1234567", "abc", "0x10", "1."])
    assert.equal(parseRewardUnits(bad), null, bad);
});

test("validation: defaults pass and convert", () => {
  const result = validatePostForm(form());
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(result.value, { amount: 5_000_000n, duration: 7, capacity: 10, selected: 1, tags: [] });
});

test("validation: plain sentences for every failure", () => {
  const rows: Array<[Partial<PostFormValues>, RegExp]> = [
    [{ description: "short" }, /at least 10 characters/],
    [{ reward: "abc" }, /Enter the reward as a number/],
    [{ reward: "0.99" }, /between 1 and 100 USDC/],
    [{ reward: "100.000001" }, /between 1 and 100 USDC/],
    [{ days: "0" }, /whole number from 1 to 365/],
    [{ days: "366" }, /whole number from 1 to 365/],
    [{ days: "1.5" }, /whole number from 1 to 365/],
    [{ contest: false, bond: true, days: "1" }, /deposit need a deadline of at least 2 days/],
    [{ entries: "0" }, /Maximum entries must be a whole number from 1 to 25/],
    [{ entries: "26" }, /from 1 to 25/],
    [{ winners: "0" }, /Winners must be a whole number/],
    [{ entries: "3", winners: "4" }, /Winners must be a whole number from 1 up to the maximum/],
    [{ agentOnly: true, humanOnly: true }, /either agent only or human only/],
    [{ tags: "a".repeat(40) }, /1-32 characters/],
  ];
  for (const [overrides, expected] of rows) {
    const result = validatePostForm(form(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
    if (!result.ok) {
      assert.match(result.error, expected);
      assert.doesNotMatch(result.error, DASHES);
    }
  }
});

test("validation: bond only matters for single takers; contest fields only for contests", () => {
  assert.equal(validatePostForm(form({ contest: true, bond: true, days: "1" })).ok, true);
  assert.equal(validatePostForm(form({ contest: false, bond: true, days: "2" })).ok, true);
  const single = validatePostForm(form({ contest: false, entries: "999", winners: "999" }));
  assert.equal(single.ok, true);
  if (single.ok) assert.deepEqual([single.value.capacity, single.value.selected], [0, 0]);
});

test("cost box: what is locked, the fee, gas in MON, the deposit note", () => {
  const lines = costLines({ reward: 5_000_000n, contest: true, bond: false });
  assert.deepEqual(lines, [
    "Locks 5 USDC in escrow now.",
    "1% fee (0.05 USDC) is taken from the payout. Refunds carry no fee.",
    `Gas is paid in MON: about ${APPROX_GAS_PER_TX} MON per transaction, a fraction of a cent.`,
  ]);
  assert.equal(APPROX_GAS_PER_TX, "0.1");
  // The fee is exact, not rounded for display: 1.5 USDC -> 0.015 USDC.
  assert.match(costLines({ reward: 1_500_000n, contest: true, bond: false })[1], /\(0\.015 USDC\)/);
  assert.match(costLines({ reward: 2_500_001n, contest: true, bond: false })[1], /\(0\.025 USDC\)/);
  // A deposit note only for single takers with a bond: max(0.50 USDC, 15%).
  assert.equal(costLines({ reward: 5_000_000n, contest: true, bond: true }).length, 3);
  const bond = costLines({ reward: 5_000_000n, contest: false, bond: true });
  assert.equal(bond.length, 4);
  assert.match(bond[3], /refundable deposit of 0\.75 USDC \(15% of the reward, at least 0\.50 USDC\)/);
  assert.match(costLines({ reward: 1_000_000n, contest: false, bond: true })[3], /deposit of 0\.5 USDC/);
  // An invalid amount shows only the gas line.
  assert.deepEqual(costLines({ reward: null, contest: true, bond: false }), [
    `Gas is paid in MON: about ${APPROX_GAS_PER_TX} MON per transaction, a fraction of a cent.`,
  ]);
});

test("steps: skip what does not apply and renumber", () => {
  assert.deepEqual(planPostSteps({ contest: true, needsApproval: true }), ["key", "upload", "approve", "create"]);
  assert.deepEqual(planPostSteps({ contest: true, needsApproval: false }), ["key", "upload", "create"]);
  assert.deepEqual(planPostSteps({ contest: false, needsApproval: true }), ["upload", "approve", "create"]);
  assert.deepEqual(planPostSteps({ contest: false, needsApproval: false }), ["upload", "create"]);
  const full = planPostSteps({ contest: true, needsApproval: true });
  assert.deepEqual(
    full.map((s) => stepText(full, s)),
    ["1/4 Sign your contest key", "2/4 Upload description", "3/4 Approve USDC", "4/4 Create bounty"],
  );
  const short = planPostSteps({ contest: false, needsApproval: false });
  assert.deepEqual(
    short.map((s) => stepText(short, s)),
    ["1/2 Upload description", "2/2 Create bounty"],
  );
  // The allowance changed while the user was signing: the plan gains or loses the approval step.
  assert.deepEqual(replan(["key", "upload", "create"], true), ["key", "upload", "approve", "create"]);
  assert.deepEqual(replan(["upload", "approve", "create"], false), ["upload", "create"]);
  assert.deepEqual(replan(["upload", "create"], false), ["upload", "create"]);
  assert.equal(stepText(["upload", "create"], "approve"), "Approve USDC");
});

test("failure notes say what is done and that no USDC was spent", () => {
  assert.equal(failureNote("key", { uploaded: false, approved: false }), "Nothing was uploaded or spent.");
  assert.equal(failureNote("upload", { uploaded: false, approved: false }), "Nothing was spent.");
  assert.match(
    failureNote("approve", { uploaded: true, approved: false }),
    /description is uploaded.*No USDC was spent/,
  );
  assert.match(
    failureNote("create", { uploaded: true, approved: true }),
    /uploaded and USDC is approved.*no USDC was spent/,
  );
  assert.match(failureNote("create", { uploaded: true, approved: false }), /uploaded, but the bounty was not created/);
});

test("form copy: gate labels, hints and choices", () => {
  assert.deepEqual(Object.keys(GATES), [
    "Anyone",
    "Proven: 3+ paid jobs, 80+ average",
    "Top: 10+ paid jobs, 90+ average",
  ]);
  assert.equal(GATE_HINT, "Counts scored paid jobs on Monad plus mirrored Base and Arc records.");
  assert.match(CONTEST_CLOSING_HINT, /closes at the deadline, or as soon as every entry slot is filled/);
  assert.match(CONTEST_CLOSING_HINT, /14 days/);
  assert.match(CONTEST_CLOSING_HINT, /split the payment evenly among all entries/);
  assert.match(KEY_CUSTODY_HINT, /Passkeys are tied to this site domain/);
  assert.match(CHOICE_CONTEST.desc, /sealed entries/);
  assert.match(CHOICE_SINGLE.desc, /first agent or human who takes it/);
  for (const text of [
    CONTEST_CLOSING_HINT,
    KEY_CUSTODY_HINT,
    CHOICE_CONTEST.name,
    CHOICE_CONTEST.desc,
    CHOICE_SINGLE.name,
    CHOICE_SINGLE.desc,
    GATE_HINT,
  ]) {
    assert.doesNotMatch(text, DASHES);
  }
});
