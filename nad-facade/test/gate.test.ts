import { test } from "node:test";
import assert from "node:assert/strict";
import { gatePasses, tierGates } from "../src/gate.js";
import { averageScore, formatUsdc, isoFromUnix, usdcAmount } from "../src/format.js";
import { parseId, parseVerifiedQuery } from "../src/validate.js";

test("gate: scoreSum exactly on the boundary passes, one point less fails", () => {
  assert.equal(gatePasses(3n, 240n, 3n, 80n), true); // 240 == 80 * 3
  assert.equal(gatePasses(3n, 239n, 3n, 80n), false);
  assert.equal(gatePasses(10n, 900n, 10n, 90n), true); // 900 == 90 * 10
  assert.equal(gatePasses(10n, 899n, 10n, 90n), false);
});

test("gate: no rounding, a 79.5 average does not pass an 80 gate", () => {
  assert.equal(gatePasses(2n, 159n, 2n, 80n), false);
  assert.equal(gatePasses(2n, 160n, 2n, 80n), true);
});

test("gate: job count threshold is independent of the score", () => {
  assert.equal(gatePasses(2n, 200n, 3n, 80n), false);
  assert.equal(gatePasses(3n, 0n, 3n, 0n), true);
  assert.equal(gatePasses(2n, 200n, 3n, 0n), false);
});

test("gate: zero jobs fail any score gate, and a gate with both thresholds at zero is disabled", () => {
  assert.equal(gatePasses(0n, 0n, 0n, 1n), false);
  assert.equal(gatePasses(0n, 0n, 0n, 0n), true);
  assert.equal(gatePasses(0n, 0n, 1n, 0n), false);
});

test("tiers: Proven needs 3 jobs at 80, Top needs 10 jobs at 90", () => {
  assert.deepEqual(tierGates(3n, 240n), {
    proven: { minJobs: 3, minAvgScore: 80, passes: true },
    top: { minJobs: 10, minAvgScore: 90, passes: false },
  });
  assert.equal(tierGates(10n, 900n).top.passes, true);
  assert.equal(tierGates(10n, 899n).top.passes, false);
  assert.equal(tierGates(10n, 899n).proven.passes, true);
  assert.equal(tierGates(2n, 200n).proven.passes, false);
});

test("average is floored to two decimals and absent without jobs", () => {
  assert.equal(averageScore(3n, 260n), "86.66");
  assert.equal(averageScore(1n, 100n), "100.00");
  assert.equal(averageScore(3n, 239n), "79.66");
  assert.equal(averageScore(0n, 0n), null);
});

test("USDC amounts use 6 decimals without trailing zeros", () => {
  assert.equal(formatUsdc(1000n), "0.001");
  assert.equal(formatUsdc(5000n), "0.005");
  assert.equal(formatUsdc(990000n), "0.99");
  assert.equal(formatUsdc(1_000_000n), "1");
  assert.equal(formatUsdc(1n), "0.000001");
  assert.equal(formatUsdc(0n), "0");
  assert.deepEqual(usdcAmount(1_980_000n), { atomic: "1980000", usdc: "1.98" });
  assert.equal(isoFromUnix(0n), null);
  assert.equal(isoFromUnix(1_791_868_239n), new Date(1_791_868_239_000).toISOString());
});

test("IDs: positive integers of at most 30 digits", () => {
  assert.equal(parseId("1"), 1n);
  assert.equal(parseId("10388"), 10388n);
  assert.equal(parseId("9".repeat(30)), BigInt("9".repeat(30)));
  for (const bad of ["0", "01", "-1", "1.5", "1e3", "0x10", " 1", "1 ", "", "9".repeat(31), "abc", undefined, ["1"]]) {
    assert.equal(parseId(bad), undefined, String(bad));
  }
});

test("verified query: defaults, valid values and bounds", () => {
  assert.deepEqual(parseVerifiedQuery({}), { ok: true, value: { minJobs: 3, minAvgScore: 80 } });
  assert.deepEqual(parseVerifiedQuery({ minJobs: "10", minAvgScore: "90" }), {
    ok: true,
    value: { minJobs: 10, minAvgScore: 90 },
  });
  assert.deepEqual(parseVerifiedQuery({ minJobs: "1", minAvgScore: "0" }), {
    ok: true,
    value: { minJobs: 1, minAvgScore: 0 },
  });
  assert.deepEqual(parseVerifiedQuery({ minJobs: "1000", minAvgScore: "100" }), {
    ok: true,
    value: { minJobs: 1000, minAvgScore: 100 },
  });
});

test("verified query: rejects anything that is not a plain in-range integer", () => {
  const bad: Record<string, unknown>[] = [
    { minJobs: "0" },
    { minJobs: "1001" },
    { minJobs: "-1" },
    { minJobs: "3.0" },
    { minJobs: "03" },
    { minJobs: "+3" },
    { minJobs: " 3" },
    { minJobs: "3e0" },
    { minJobs: "0x3" },
    { minJobs: "" },
    { minJobs: ["3", "4"] },
    { minJobs: { a: "1" } },
    { minAvgScore: "101" },
    { minAvgScore: "-5" },
    { minAvgScore: "80.5" },
    { minAvgScore: "NaN" },
    { limit: "10" },
    { minJobs: "3", extra: "x" },
  ];
  for (const query of bad) {
    const result = parseVerifiedQuery(query);
    assert.equal(result.ok, false, JSON.stringify(query));
  }
});
