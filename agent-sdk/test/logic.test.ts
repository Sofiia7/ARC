import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { parseUsdc, resolveDeadline, matchesBountyFilter, agentIdFromReceiptLogs, workerBondFor } from "../src/logic.js";
import type { BountyMeta } from "../src/types.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

function baseMeta(overrides: Partial<BountyMeta> = {}): BountyMeta {
  return {
    jobId: 1n,
    poster: ZERO,
    reward: 10_000_000n, // 10 USDC
    deadline: 0n,
    ipfsDescHash: "",
    category: "dev",
    tags: [],
    agentId: 0n,
    agentOnly: false,
    humanOnly: false,
    whitelistedProvider: ZERO,
    assignedProvider: ZERO,
    submittedResultHash: "",
    submittedAt: 0n,
    isTaken: false,
    rejectedAt: 0n,
    rejectionReasonHash: "",
    inDispute: false,
    resolved: false,
    disputeInitiator: ZERO,
    disputeRaisedAt: 0n,
    disputeReasonHash: "",
    disputeResponseHash: "",
    disputeRulingHash: "",
    requireWorkerBond: false,
    workerBond: 0n,
    ...overrides,
  };
}

describe("parseUsdc", () => {
  it("scales dollars to 6-decimal USDC units", () => {
    expect(parseUsdc(10)).toBe(10_000_000n);
    expect(parseUsdc(1.5)).toBe(1_500_000n);
  });

  it("rounds to the nearest unit rather than truncating with float drift", () => {
    // 0.1 + 0.2 style float artifacts must not leak into on-chain amounts.
    expect(parseUsdc(0.1)).toBe(100_000n);
    expect(parseUsdc(19.99)).toBe(19_990_000n);
  });
});

describe("resolveDeadline", () => {
  const now = 1_800_000_000; // fixed reference point, well past the 1e9 cutoff

  it("treats a Date as an absolute deadline", () => {
    const d = new Date(2026 * 1000); // arbitrary but deterministic
    expect(resolveDeadline(d, now)).toBe(BigInt(Math.floor(d.getTime() / 1000)));
  });

  it("treats a number below 1e9 as a duration in seconds from now", () => {
    expect(resolveDeadline(3600, now)).toBe(BigInt(now + 3600));
    expect(resolveDeadline(0, now)).toBe(BigInt(now));
  });

  it("treats a number at or above 1e9 as an absolute unix timestamp", () => {
    expect(resolveDeadline(1_000_000_000, now)).toBe(1_000_000_000n);
    expect(resolveDeadline(2_000_000_000, now)).toBe(2_000_000_000n);
  });
});

describe("matchesBountyFilter", () => {
  it("passes everything through an empty filter", () => {
    expect(matchesBountyFilter(baseMeta(), {})).toBe(true);
  });

  it("filters by category", () => {
    const m = baseMeta({ category: "content" });
    expect(matchesBountyFilter(m, { category: "content" })).toBe(true);
    expect(matchesBountyFilter(m, { category: "dev" })).toBe(false);
  });

  it("agentOnly: true requires agentOnly bounties, false excludes them", () => {
    const agentBounty = baseMeta({ agentOnly: true });
    const openBounty = baseMeta({ agentOnly: false });
    expect(matchesBountyFilter(agentBounty, { agentOnly: true })).toBe(true);
    expect(matchesBountyFilter(openBounty, { agentOnly: true })).toBe(false);
    expect(matchesBountyFilter(agentBounty, { agentOnly: false })).toBe(false);
    expect(matchesBountyFilter(openBounty, { agentOnly: false })).toBe(true);
  });

  it("humanOnly mirrors agentOnly semantics", () => {
    const humanBounty = baseMeta({ humanOnly: true });
    expect(matchesBountyFilter(humanBounty, { humanOnly: true })).toBe(true);
    expect(matchesBountyFilter(humanBounty, { humanOnly: false })).toBe(false);
  });

  it("filters by reward bounds (dollars, not raw units)", () => {
    const m = baseMeta({ reward: 10_000_000n }); // $10
    expect(matchesBountyFilter(m, { maxReward: 20 })).toBe(true);
    expect(matchesBountyFilter(m, { maxReward: 5 })).toBe(false);
    expect(matchesBountyFilter(m, { minReward: 5 })).toBe(true);
    expect(matchesBountyFilter(m, { minReward: 20 })).toBe(false);
  });
});

describe("agentIdFromReceiptLogs", () => {
  const registry: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
  const self: Address = "0x000000000000000000000000000000000000AbCd";
  const TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const ZERO_TOPIC = "0x" + "0".repeat(64);

  function transferLog(opts: { address?: string; from?: string; to?: string; tokenId?: bigint; topicsCount?: number }) {
    const toTopic = "0x" + (opts.to ?? self).toLowerCase().slice(2).padStart(64, "0");
    const topics = [
      opts.topicsCount === 3 ? undefined : TRANSFER_SIG,
      opts.from ?? ZERO_TOPIC,
      toTopic,
      "0x" + (opts.tokenId ?? 42n).toString(16).padStart(64, "0"),
    ].filter((t): t is string => t !== undefined);
    return { address: opts.address ?? registry, topics };
  }

  it("extracts the tokenId from a matching Transfer(0x0 -> self) log", () => {
    const logs = [transferLog({ tokenId: 845036n })];
    expect(agentIdFromReceiptLogs(logs, registry, self)).toBe(845036n);
  });

  it("ignores logs from a different contract address", () => {
    const logs = [transferLog({ address: "0x000000000000000000000000000000000000dEaD", tokenId: 1n })];
    expect(agentIdFromReceiptLogs(logs, registry, self)).toBeNull();
  });

  it("ignores a Transfer not minted to self", () => {
    const otherAddr: Address = "0x0000000000000000000000000000000000FEED0";
    const logs = [transferLog({ to: otherAddr, tokenId: 1n })];
    expect(agentIdFromReceiptLogs(logs, registry, self)).toBeNull();
  });

  it("ignores a Transfer that isn't a mint (from != 0x0)", () => {
    const fromTopic = "0x" + "1".padStart(64, "0");
    const logs = [transferLog({ from: fromTopic, tokenId: 1n })];
    expect(agentIdFromReceiptLogs(logs, registry, self)).toBeNull();
  });

  it("ignores a log with fewer than 4 topics (not a full indexed Transfer)", () => {
    const logs = [transferLog({ topicsCount: 3, tokenId: 1n })];
    expect(agentIdFromReceiptLogs(logs, registry, self)).toBeNull();
  });

  it("returns null when no logs match", () => {
    expect(agentIdFromReceiptLogs([], registry, self)).toBeNull();
  });
});

describe("workerBondFor (V4)", () => {
  it("applies the $0.50 floor for small rewards ($1 → $0.50)", () => {
    expect(workerBondFor(1_000_000n)).toBe(500_000n);
  });

  it("uses the proportional bond above the floor ($5 → $0.75)", () => {
    expect(workerBondFor(5_000_000n)).toBe(750_000n);
  });

  it("returns the floor exactly at the crossover point (~$3.33)", () => {
    // reward where 15% == $0.50: pct is not > min, so the floor branch wins
    // (same value either way — this pins the boundary behavior).
    const reward = (500_000n * 10_000n) / 1500n; // 3_333_333
    expect(workerBondFor(reward)).toBe(500_000n);
  });

  it("respects custom on-chain parameters", () => {
    expect(workerBondFor(10_000_000n, 1000n, 2_000_000n)).toBe(2_000_000n); // 10% of $10 < $2 floor
    expect(workerBondFor(100_000_000n, 1000n, 2_000_000n)).toBe(10_000_000n); // 10% of $100
  });
});
