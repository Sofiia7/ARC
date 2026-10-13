import { test } from "node:test";
import assert from "node:assert/strict";
import { zeroAddress } from "viem";
import { buildContestBody, deriveContestState, splitContestPayout, type StateInput } from "../src/contest.js";
import { ADAPTER, HUMAN, OWNER_10388, POSTER, WALLET_10388, meta } from "./helpers.js";

const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);

test("split: 1% fee floored, even share, remainder to the first winner", () => {
  assert.deepEqual(splitContestPayout(2_000_000n, 100n, 1), { fee: 20_000n, net: 1_980_000n, amounts: [1_980_000n] });
  assert.deepEqual(splitContestPayout(2_000_000n, 100n, 2).amounts, [990_000n, 990_000n]);
  // 1_000_001 * 100 / 10000 floors to 10000, net 990_001, odd split: the extra unit goes to the first winner.
  assert.deepEqual(splitContestPayout(1_000_001n, 100n, 2), {
    fee: 10_000n,
    net: 990_001n,
    amounts: [495_001n, 495_000n],
  });
  assert.deepEqual(splitContestPayout(1_000_010n, 100n, 3).amounts, [330_004n, 330_003n, 330_003n]);
});

test("split: the payouts always add up to the net and fee + net equals the reward", () => {
  for (const reward of [1_000_000n, 1_000_001n, 1_234_567n, 100_000_000n, 3_000_007n]) {
    for (const winners of [1, 2, 3, 5, 25]) {
      const split = splitContestPayout(reward, 100n, winners);
      assert.equal(sum(split.amounts), split.net);
      assert.equal(split.fee + split.net, reward);
      assert.ok(split.amounts[0] >= split.amounts[winners - 1]);
      assert.ok(split.amounts.slice(1).every((amount) => amount === split.amounts[winners - 1]));
    }
  }
  assert.deepEqual(splitContestPayout(1_000_000n, 0n, 2).amounts, [500_000n, 500_000n]);
  assert.deepEqual(splitContestPayout(1_000_000n, 100n, 0), { fee: 10_000n, net: 990_000n, amounts: [] });
  assert.throws(() => splitContestPayout(1n, 100n, -1));
});

const base: StateInput = {
  resolved: false,
  rejectedAt: 0n,
  inDispute: false,
  entryCount: 2n,
  closedAt: 1000n,
  reviewDeadline: 5000n,
  awardedCount: 0,
  challengerCount: 0,
  now: 2000n,
};

test("state: every stage of the contest lifecycle", () => {
  assert.equal(deriveContestState({ ...base, closedAt: 0n, reviewDeadline: 0n }), "open");
  assert.equal(deriveContestState({ ...base, entryCount: 0n }), "closed_no_entries");
  assert.equal(deriveContestState(base), "in_review");
  assert.equal(deriveContestState({ ...base, now: 5000n }), "in_review");
  assert.equal(deriveContestState({ ...base, now: 5001n }), "review_expired");
  assert.equal(
    deriveContestState({ ...base, rejectedAt: 1500n, now: 1500n + 48n * 3600n }),
    "rejection_challenge_window",
  );
  assert.equal(deriveContestState({ ...base, rejectedAt: 1500n, now: 1501n + 48n * 3600n }), "rejection_unchallenged");
  assert.equal(deriveContestState({ ...base, rejectedAt: 1500n, challengerCount: 1 }), "in_dispute");
  assert.equal(deriveContestState({ ...base, rejectedAt: 1500n, inDispute: true }), "in_dispute");
  assert.equal(deriveContestState({ ...base, resolved: true, awardedCount: 1 }), "settled");
  assert.equal(deriveContestState({ ...base, resolved: true, awardedCount: 0 }), "refunded");
});

const context = { chainId: 143, adapter: ADAPTER };
const block = { number: 1000n, hash: `0x${"ab".repeat(32)}` as const, timestamp: 1_792_000_000n };

test("result: winners are paid to the identity owner, never the working wallet, with the net after the fee", () => {
  const body = buildContestBody({
    context,
    block,
    jobId: 2n,
    meta: meta({
      jobId: 2n,
      poster: POSTER,
      reward: 2_000_000n,
      contest: true,
      resolved: true,
      winners: 1,
      maxEntries: 3,
    }),
    entries: [{ agentId: 10388n, entrant: WALLET_10388, resultHash: "ipfs://QmCipher", awarded: true }],
    contestState: [1n, 1_791_868_239n, 1_793_077_839n, true],
    challengers: [],
    feeBps: 100n,
    owners: new Map([[10388n, OWNER_10388]]),
  });
  assert.equal(body.state, "settled");
  assert.equal(body.entries[0].entrant, WALLET_10388);
  assert.equal(body.entries[0].identityOwner, OWNER_10388);
  assert.equal(body.entries[0].payout?.recipient, OWNER_10388);
  assert.notEqual(body.entries[0].payout?.recipient, WALLET_10388);
  assert.deepEqual(body.entries[0].payout?.net, { atomic: "1980000", usdc: "1.98" });
  assert.equal(body.entries[0].ciphertextCid, "ipfs://QmCipher");
  assert.equal(body.entries[0].score, null);
  assert.equal(body.scores.available, false);
  assert.deepEqual(body.settlement?.fee, { atomic: "20000", usdc: "0.02" });
  assert.deepEqual(body.settlement?.net, { atomic: "1980000", usdc: "1.98" });
  assert.equal(body.sourceBlock, 1000n);
});

test("result: several winners share the net, the remainder goes to the first awarded entry", () => {
  const entries = [
    { agentId: 0n, entrant: HUMAN, resultHash: "ipfs://a", awarded: true },
    { agentId: 10388n, entrant: WALLET_10388, resultHash: "ipfs://b", awarded: false },
    { agentId: 10388n, entrant: POSTER, resultHash: "ipfs://c", awarded: true },
  ];
  const body = buildContestBody({
    context,
    block,
    jobId: 9n,
    meta: meta({
      jobId: 9n,
      poster: POSTER,
      reward: 1_000_001n,
      contest: true,
      resolved: true,
      winners: 2,
      maxEntries: 3,
    }),
    entries,
    contestState: [3n, 10n, 20n, true],
    challengers: [],
    feeBps: 100n,
    owners: new Map([[10388n, OWNER_10388]]),
  });
  assert.equal(body.entries[0].payout?.recipient, HUMAN); // a human entrant is its own recipient
  assert.equal(body.entries[0].identityOwner, null);
  assert.equal(body.entries[1].payout, null);
  assert.equal(body.entries[2].payout?.recipient, OWNER_10388);
  assert.deepEqual([body.entries[0].payout?.net.atomic, body.entries[2].payout?.net.atomic], ["495001", "495000"]);
});

test("result: an unresolvable owner means the payout is parked, not sent to the entrant", () => {
  const body = buildContestBody({
    context,
    block,
    jobId: 2n,
    meta: meta({
      jobId: 2n,
      poster: POSTER,
      reward: 1_000_000n,
      contest: true,
      resolved: true,
      winners: 1,
      maxEntries: 1,
    }),
    entries: [{ agentId: 7n, entrant: WALLET_10388, resultHash: "ipfs://x", awarded: true }],
    contestState: [1n, 10n, 20n, true],
    challengers: [],
    feeBps: 100n,
    owners: new Map([[7n, null]]),
  });
  assert.equal(body.entries[0].payout?.recipient, null);
  assert.equal(body.entries[0].payout?.parked, true);
});

test("result: an open contest has no winners and no settlement", () => {
  const body = buildContestBody({
    context,
    block,
    jobId: 3n,
    meta: meta({
      jobId: 3n,
      poster: POSTER,
      reward: 1_000_000n,
      contest: true,
      winners: 1,
      maxEntries: 3,
      deadline: 1_793_000_000n,
    }),
    entries: [{ agentId: 0n, entrant: HUMAN, resultHash: "ipfs://a", awarded: false }],
    contestState: [1n, 0n, 0n, false],
    challengers: [],
    feeBps: 100n,
    owners: new Map(),
  });
  assert.equal(body.state, "open");
  assert.equal(body.settlement, null);
  assert.equal(body.timeline.closedAt, null);
  assert.ok(body.entries.every((entry) => entry.payout === null));
  assert.notEqual(body.poster, zeroAddress);
});
