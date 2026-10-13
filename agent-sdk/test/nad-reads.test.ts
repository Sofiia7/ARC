import { describe, it, expect, beforeEach, vi } from "vitest";
import { NadBountyAgent, MIRROR_SOURCE_CHAINS } from "../src/NadBountyAgent.js";
import { identityKey } from "../src/nadIdentity.js";
import { MONAD_NETWORKS } from "../src/constants.js";
import { THROWAWAY_KEYS, ZERO, addresses, mainnetWiring, mock, resetMocks, state } from "./helpers/nadMock.js";

vi.mock("viem", async (importOriginal) => (await import("./helpers/nadMock.js")).viemMock(await importOriginal()));
vi.mock("../src/signers/viemSigner.js", async () => (await import("./helpers/nadMock.js")).signerMock());

const reader = () => new NadBountyAgent({ network: "monad-mainnet" });
const worker = () => new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.worker });
const calls = () => mock.read.mock.calls.map(([call]) => call.functionName);

beforeEach(() => resetMocks(mainnetWiring()));

describe("protocol parameters", () => {
  it("reads paused, the reward cap and the fee", async () => {
    state.reads["paused"] = false;
    state.reads["maxBountyAmount"] = 100_000_000n;
    state.reads["feeBps"] = 100n;
    const agent = reader();
    expect(await agent.isPaused()).toBe(false);
    expect(await agent.maxBountyAmount()).toBe(100_000_000n);
    expect(await agent.feeBps()).toBe(100n);
    expect(mock.read.mock.calls[0]![0]).toMatchObject({ address: agent.bountyAdapter, functionName: "paused" });
  });
});

describe("parked balances", () => {
  it("reads pendingWithdrawals for an explicit or the client's own address", async () => {
    state.reads["pendingWithdrawals"] = (args: readonly unknown[]) => (args[0] === addresses.worker ? 5n : 0n);
    expect(await reader().pendingWithdrawals(addresses.worker)).toBe(5n);
    expect(await worker().pendingWithdrawals()).toBe(5n);
  });
  it("refuses to guess an address for a read-only client, before any RPC call", async () => {
    await expect(reader().pendingWithdrawals()).rejects.toThrow(/no private key/);
    await expect(reader().getMyPostedBounties()).rejects.toThrow(/no private key/);
    await expect(reader().getMyAssignedBounties()).rejects.toThrow(/no private key/);
    await expect(reader().usdcBalance()).rejects.toThrow(/no private key/);
    expect(mock.read).not.toHaveBeenCalled();
  });
  it("reads pendingIdentityWithdrawals and rejects agentId 0", async () => {
    state.reads["pendingIdentityWithdrawals"] = (args: readonly unknown[]) => (args[0] === 7n ? 9n : 0n);
    expect(await reader().pendingIdentityWithdrawals(7n)).toBe(9n);
    await expect(reader().pendingIdentityWithdrawals(0n)).rejects.toThrow("positive bigint");
  });
  it("reads both balances in one multicall", async () => {
    state.reads["pendingWithdrawals"] = 3n;
    state.reads["pendingIdentityWithdrawals"] = 4n;
    expect(await reader().getPendingWithdrawals({ address: addresses.worker, agentId: 7n })).toEqual({
      address: 3n,
      identity: 4n,
    });
    expect(await reader().getPendingWithdrawals({ agentId: 7n })).toEqual({ address: 0n, identity: 4n });
    expect(mock.multicall).toHaveBeenCalledTimes(2);
    await expect(reader().getPendingWithdrawals()).rejects.toThrow("address and/or an agentId");
  });
});

describe("a wallet's bounties", () => {
  it("lists posted and assigned job ids for the given or own wallet", async () => {
    state.reads["getMyPostedBounties"] = [1n, 2n];
    state.reads["getMyAssignedBounties"] = [3n];
    const agent = worker();
    expect(await agent.getMyPostedBounties()).toEqual([1n, 2n]);
    expect(await agent.getMyAssignedBounties(addresses.owner)).toEqual([3n]);
    expect(mock.read.mock.calls[0]![0].args).toEqual([addresses.worker]);
    expect(mock.read.mock.calls[1]![0].args).toEqual([addresses.owner]);
  });
  it("lists open bounties with metadata in one batched read after the id query", async () => {
    state.reads["getOpenBounties"] = [5n, 6n];
    state.reads["getBountyMeta"] = (args: readonly unknown[]) => ({ jobId: args[0], reward: 1_000_000n });
    const list = await reader().listOpenBounties({ category: "dev", limit: 2n });
    expect(list.map((meta) => meta.jobId)).toEqual([5n, 6n]);
    expect(mock.multicall).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual(["getOpenBounties", "getBountyMeta", "getBountyMeta"]);
    state.reads["getOpenBounties"] = [];
    mock.multicall.mockClear();
    expect(await reader().listOpenBounties()).toEqual([]);
    expect(mock.multicall).not.toHaveBeenCalled();
  });
});

describe("identity reputation", () => {
  it("rejects with a clear argument error for agentId 0 without a human wallet, before the RPC call", async () => {
    await expect(reader().getIdentityReputation(0n)).rejects.toThrow(/agentId 0 identifies a human/);
    await expect(reader().getIdentityReputation(0n, ZERO)).rejects.toThrow(/nonzero humanWallet/);
    await expect(reader().getIdentityReputation(0n, "0x12" as never)).rejects.toThrow(/nonzero humanWallet/);
    await expect(reader().getIdentityReputation(-1n)).rejects.toThrow(RangeError);
    expect(mock.read).not.toHaveBeenCalled();
    expect(mock.chain).not.toHaveBeenCalled();
  });
  it("still works for an agent on a read-only client and for a human with a wallet", async () => {
    state.reads["getIdentityReputation"] = [2n, 180n];
    expect(await reader().getIdentityReputation(10388n)).toEqual([2n, 180n]);
    expect(await reader().getIdentityReputation(0n, addresses.owner)).toEqual([2n, 180n]);
    expect(await worker().getIdentityReputation(0n)).toEqual([2n, 180n]);
  });
});

describe("identityKey and localReputation", () => {
  // Both vectors were read from the live adapter's pure identityKey() on Monad mainnet.
  const AGENT_10388 = "0xa0e905e5b7b45132fdcec3710c9dcf57c1faaeacf7162a3db7827c585ea3a0eb";
  const HUMAN_4076 = "0x550715ea02c20677591ca3ea79a38bb78624d533e0ddc0611d62797db090ba32";
  const WALLET_4076 = "0x4076F0Ccc2E8c0B94002cAdeDE0186D064EA95e6";

  it("matches the contract: agent history follows the id, human history follows the wallet", () => {
    expect(identityKey(10388n)).toBe(AGENT_10388);
    expect(identityKey(10388n, WALLET_4076)).toBe(AGENT_10388);
    expect(identityKey(0n, WALLET_4076)).toBe(HUMAN_4076);
    expect(reader().identityKey(10388n)).toBe(AGENT_10388);
  });
  it("rejects what the contract reverts InvalidIdentity for", () => {
    expect(() => identityKey(0n)).toThrow(/nonzero wallet/);
    expect(() => identityKey(0n, ZERO)).toThrow(/nonzero wallet/);
    expect(() => identityKey(-1n)).toThrow(RangeError);
    expect(() => reader().identityKey(0n)).toThrow(/nonzero wallet/);
  });
  it("reads localReputation by key or by identity", async () => {
    state.reads["localReputation"] = (args: readonly unknown[]) => (args[0] === AGENT_10388 ? [2n, 180n] : [0n, 0n]);
    const agent = reader();
    expect(await agent.localReputation(AGENT_10388)).toEqual({ paidJobs: 2n, scoreSum: 180n });
    expect(await agent.localReputation({ agentId: 10388n })).toEqual({ paidJobs: 2n, scoreSum: 180n });
    expect(await agent.localReputation({ agentId: 0n, humanWallet: WALLET_4076 })).toEqual({
      paidJobs: 0n,
      scoreSum: 0n,
    });
    await expect(agent.localReputation("0x1234")).rejects.toThrow("bytes32");
  });
  it("uses the worker's own address as the default human wallet", () => {
    expect(worker().identityKey(0n)).toBe(identityKey(0n, addresses.worker));
  });
});

describe("agent reputation, unique posters and contests", () => {
  it("reads the registry summary and the unique poster count", async () => {
    state.reads["getAgentReputation"] = { averageScore: 90n, totalFeedbacks: 2n, totalJobs: 2n };
    state.reads["uniquePosterCount"] = 1n;
    expect(await reader().getAgentReputation(10388n)).toEqual({ averageScore: 90n, totalFeedbacks: 2n, totalJobs: 2n });
    expect(await reader().uniquePosterCount(10388n)).toBe(1n);
    await expect(reader().uniquePosterCount(0n)).rejects.toThrow("positive bigint");
    await expect(reader().getAgentReputation(0n)).rejects.toThrow("positive bigint");
  });
  it("reads when a contest closed", async () => {
    state.reads["contestClosedAt"] = 1_700_000_000n;
    expect(await reader().contestClosedAt(3n)).toBe(1_700_000_000n);
  });
  it("unwraps the contract's index+1 into an index or null", async () => {
    state.reads["getContestEntryIndex"] = (args: readonly unknown[]) => (args[1] === 10388n ? 3n : 0n);
    const agent = worker();
    expect(await agent.getContestEntryIndex(3n, 10388n)).toBe(2);
    expect(await agent.getContestEntryIndex(3n, 99n)).toBeNull();
    expect(mock.read.mock.calls[0]![0].args).toEqual([3n, 10388n, addresses.worker]);
  });
  it("needs a wallet for a human entrant on a read-only client", async () => {
    await expect(reader().getContestEntryIndex(3n, 0n)).rejects.toThrow(/no private key/);
    expect(mock.read).not.toHaveBeenCalled();
  });
});

describe("ReputationMirror", () => {
  it("uses the built-in mirror address of the canonical adapter without asking the adapter", async () => {
    state.reads["getTotals"] = [3n, 270n];
    expect(await reader().getMirrorTotals(addresses.owner)).toEqual({ paidJobs: 3n, scoreSum: 270n });
    expect(mock.read.mock.calls[0]![0]).toMatchObject({
      address: MONAD_NETWORKS["monad-mainnet"].reputationMirror,
      functionName: "getTotals",
    });
    expect(calls()).not.toContain("reputationMirror");
  });
  it("reads the mirror from a custom adapter once and caches it", async () => {
    state.reads["reputationMirror"] = "0x0000000000000000000000000000000000000c02";
    state.reads["getTotals"] = [0n, 0n];
    const agent = new NadBountyAgent({
      network: "monad-mainnet",
      bountyAdapterAddress: "0x0000000000000000000000000000000000000048",
    });
    await agent.getMirrorTotals(addresses.owner);
    await agent.getMirrorTotals(addresses.owner);
    expect(calls().filter((name) => name === "reputationMirror")).toHaveLength(1);
    expect(mock.read.mock.calls[mock.read.mock.calls.length - 1]![0].address).toBe(
      "0x0000000000000000000000000000000000000c02",
    );
  });
  it("returns the Base and Arc snapshots, asking the mirror for chains 8453 and 5042", async () => {
    state.reads["records"] = (args: readonly unknown[]) =>
      args[1] === MIRROR_SOURCE_CHAINS.base ? [2n, 180n, 50_000n, 1_790_000_000n] : [0n, 0n, 0n, 0n];
    const records = await reader().getMirrorRecords(addresses.owner);
    expect(records.base).toEqual({ paidJobs: 2n, scoreSum: 180n, sourceBlock: 50_000n, updatedAt: 1_790_000_000n });
    expect(records.arc.paidJobs).toBe(0n);
    expect(MIRROR_SOURCE_CHAINS).toEqual({ base: 8453n, arc: 5042n });
    expect(mock.multicall).toHaveBeenCalledTimes(1);
  });
  it("validates the owner address", async () => {
    await expect(reader().getMirrorTotals(ZERO)).rejects.toThrow("identity owner");
    await expect(reader().getMirrorRecords("0x1" as never)).rejects.toThrow("identity owner");
  });
});

describe("balances", () => {
  it("reads USDC and MON for a wallet", async () => {
    state.reads["balanceOf"] = 7_000_000n;
    expect(await worker().usdcBalance()).toBe(7_000_000n);
    expect(await worker().monBalance()).toBe(5n * 10n ** 18n);
    expect(mock.balance).toHaveBeenCalledWith({ address: addresses.worker });
  });
});
