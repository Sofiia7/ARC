import { describe, it, expect } from "vitest";
import { DEFAULT_SPEND_LIMITS, readSpendLimits, spendLimitError } from "../src/limits.js";

describe("readSpendLimits", () => {
  it("falls back to the defaults when nothing is set", () => {
    expect(readSpendLimits({})).toEqual(DEFAULT_SPEND_LIMITS);
  });

  it("reads both caps from the environment", () => {
    expect(readSpendLimits({ ARCBOUNTY_MAX_REWARD_USDC: "5", ARCBOUNTY_MAX_SPEND_USDC: "12.5" }))
      .toEqual({ maxRewardUsdc: 5, maxSpendUsdc: 12.5 });
  });

  it("refuses a cap that is not a positive number, naming the variable", () => {
    expect(() => readSpendLimits({ ARCBOUNTY_MAX_REWARD_USDC: "abc" })).toThrow(/ARCBOUNTY_MAX_REWARD_USDC/);
    expect(() => readSpendLimits({ ARCBOUNTY_MAX_SPEND_USDC: "0" })).toThrow(/ARCBOUNTY_MAX_SPEND_USDC/);
    expect(() => readSpendLimits({ ARCBOUNTY_MAX_SPEND_USDC: "-5" })).toThrow(/ARCBOUNTY_MAX_SPEND_USDC/);
  });
});

describe("spendLimitError", () => {
  const limits = { maxRewardUsdc: 20, maxSpendUsdc: 50 };

  it("lets a reward through when it fits both caps", () => {
    expect(spendLimitError(20, 30, limits)).toBeNull();
  });

  it("names the per-bounty cap when one reward is too big", () => {
    expect(spendLimitError(25, 0, limits)).toMatch(/ARCBOUNTY_MAX_REWARD_USDC/);
  });

  it("names the session cap when this reward would push total spend past it", () => {
    expect(spendLimitError(15, 40, limits)).toMatch(/ARCBOUNTY_MAX_SPEND_USDC/);
  });
});

describe("custom variable names (the Monad server uses NAD_*)", () => {
  const names = { reward: "NAD_MAX_REWARD_USDC", spend: "NAD_MAX_SPEND_USDC" };

  it("reads the caps from the given variables and ignores the ARCBOUNTY ones", () => {
    expect(readSpendLimits({ NAD_MAX_REWARD_USDC: "7", NAD_MAX_SPEND_USDC: "9", ARCBOUNTY_MAX_REWARD_USDC: "1" }, names))
      .toEqual({ maxRewardUsdc: 7, maxSpendUsdc: 9 });
    expect(() => readSpendLimits({ NAD_MAX_SPEND_USDC: "x" }, names)).toThrow(/NAD_MAX_SPEND_USDC/);
  });

  it("names those variables in the refusal messages", () => {
    const limits = { maxRewardUsdc: 20, maxSpendUsdc: 50 };
    expect(spendLimitError(25, 0, limits, names)).toMatch(/NAD_MAX_REWARD_USDC/);
    expect(spendLimitError(15, 40, limits, names)).toMatch(/NAD_MAX_SPEND_USDC/);
  });
});

describe("spendLimitError precision", () => {
  it("compares whole micro-USDC, so decimal sums that land exactly on the cap pass", () => {
    const limits = { maxRewardUsdc: 20, maxSpendUsdc: 50 };
    expect(0.1 + 0.2).not.toBe(0.3); // the float noise this guards against
    expect(spendLimitError(19.9, 30.1, limits)).toBeNull();
    expect(spendLimitError(19.900001, 30.1, limits)).toMatch(/per run/);
  });
});
