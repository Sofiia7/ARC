import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAddress, isAddress } from "viem";
import { NadBountyAgent, MONAD_NETWORKS } from "../src/NadBountyAgent.js";
import { MONAD_MULTICALL3, MONAD_NETWORKS as FROM_CONSTANTS } from "../src/constants.js";
import { THROWAWAY_KEYS, mainnetWiring, mock, resetMocks, state } from "./helpers/nadMock.js";

vi.mock("viem", async (importOriginal) => (await import("./helpers/nadMock.js")).viemMock(await importOriginal()));
vi.mock("../src/signers/viemSigner.js", async () => (await import("./helpers/nadMock.js")).signerMock());

const CANONICAL = "0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020";
const params = {
  provider: "0x0000000000000000000000000000000000000000",
  reward: 10_000_000n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400),
  ipfsDescHash: "ipfs://description",
  category: "dev",
  tags: [],
  agentOnly: false,
  humanOnly: false,
  requireWorkerBond: false,
  contest: true,
  maxEntries: 10,
  winners: 2,
  minJobs: 0n,
  minAvgScore: 0,
} as const;

beforeEach(() => resetMocks(mainnetWiring()));

describe("built-in Monad mainnet deployment", () => {
  it("lists exactly the verified mainnet addresses, each correctly checksummed", () => {
    const mainnet = MONAD_NETWORKS["monad-mainnet"];
    expect(mainnet).toMatchObject({
      chainId: 143,
      rpcUrl: "https://rpc.monad.xyz",
      defaultBountyAdapter: CANONICAL,
      agenticCommerce: "0x8F367e17d96EB83c4A51b3349e3CE30447aDB7e2",
      reputationMirror: "0x59e970574D9aDc30892d094C893DA4B73EBE40a0",
      keeperReceiver: "0x5B7559f1973D371d1b6A1e6ED22BeCbb4594e17f",
      usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      safe: "0x74678c072Ca546f11466CD44eB7e21730a312a54",
    });
    for (const value of [
      mainnet.defaultBountyAdapter,
      mainnet.agenticCommerce,
      mainnet.reputationMirror,
      mainnet.keeperReceiver,
      mainnet.usdc,
      mainnet.identity,
      mainnet.reputation,
      mainnet.safe,
      MONAD_MULTICALL3,
    ]) {
      expect(isAddress(value!, { strict: true })).toBe(true);
      expect(getAddress(value!)).toBe(value);
    }
  });

  it("is exported from both the constants module and the legacy NadBountyAgent module", () => {
    expect(MONAD_NETWORKS).toBe(FROM_CONSTANTS);
  });

  it("works without passing an adapter address", () => {
    const agent = new NadBountyAgent({ network: "monad-mainnet" });
    expect(agent.bountyAdapter).toBe(CANONICAL);
    expect(agent.network.chainId).toBe(143);
    expect(agent.network.agenticCommerce).toBe("0x8F367e17d96EB83c4A51b3349e3CE30447aDB7e2");
  });

  it("still allows an override", () => {
    const other = "0x0000000000000000000000000000000000000048";
    expect(new NadBountyAgent({ network: "monad-mainnet", bountyAdapterAddress: other }).bountyAdapter).toBe(other);
  });

  it("rejects an explicit zero or malformed adapter even on mainnet", () => {
    expect(
      () =>
        new NadBountyAgent({
          network: "monad-mainnet",
          bountyAdapterAddress: "0x0000000000000000000000000000000000000000",
        }),
    ).toThrow("nonzero");
    expect(() => new NadBountyAgent({ network: "monad-mainnet", bountyAdapterAddress: "0x1234" as never })).toThrow(
      "nonzero",
    );
  });

  it("gives the chain Multicall3 so batched reads work", () => {
    new NadBountyAgent({ network: "monad-mainnet" });
    const chain = mock.client.mock.calls[0]![0].chain;
    expect(chain.id).toBe(143);
    expect(chain.contracts.multicall3.address).toBe(MONAD_MULTICALL3);
    expect(chain.nativeCurrency).toMatchObject({ symbol: "MON", decimals: 18 });
  });
});

describe("Monad testnet stays explicit-address only", () => {
  it("has no built-in adapter and fails fast without one", () => {
    expect(MONAD_NETWORKS["monad-testnet"].defaultBountyAdapter).toBeUndefined();
    expect(() => new NadBountyAgent({ network: "monad-testnet" })).toThrow(/nonzero.*monad-testnet/);
  });
  it("accepts an explicit address", () => {
    const agent = new NadBountyAgent({
      network: "monad-testnet",
      bountyAdapterAddress: "0x0000000000000000000000000000000000000048",
    });
    expect(agent.network.chainId).toBe(10143);
  });
  it("rejects an unknown network name", () => {
    expect(() => new NadBountyAgent({ network: "monad-devnet" as never })).toThrow(
      "Expected monad-mainnet or monad-testnet",
    );
  });
});

describe("dependency wiring is verified before every write", () => {
  it("checks the escrow and the mirror on the canonical adapter, and refuses to sign on a mismatch", async () => {
    state.reads["agenticCommerce"] = "0x0000000000000000000000000000000000000bad";
    const agent = new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.owner });
    await expect(agent.createBounty(params)).rejects.toThrow("agenticCommerce mismatch");
    expect(mock.write).not.toHaveBeenCalled();
    state.reads["agenticCommerce"] = mainnetWiring()["agenticCommerce"];
    state.reads["reputationMirror"] = "0x0000000000000000000000000000000000000bad";
    await expect(agent.pickContestWinners(1n, [0], [90])).rejects.toThrow("reputationMirror mismatch");
    expect(mock.write).not.toHaveBeenCalled();
  });

  it("verifies USDC and the registries on the canonical adapter too", async () => {
    state.reads["usdc"] = "0x0000000000000000000000000000000000000bad";
    await expect(
      new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.owner }).cancelBounty(1n),
    ).rejects.toThrow("usdc mismatch");
    expect(mock.write).not.toHaveBeenCalled();
  });

  it("lets a custom adapter bring its own escrow and mirror (only chain-wide dependencies are pinned)", async () => {
    const custom = "0x0000000000000000000000000000000000000048";
    state.reads["agenticCommerce"] = "0x0000000000000000000000000000000000000c01";
    state.reads["reputationMirror"] = "0x0000000000000000000000000000000000000c02";
    const agent = new NadBountyAgent({
      network: "monad-mainnet",
      bountyAdapterAddress: custom,
      privateKey: THROWAWAY_KEYS.owner,
    });
    await agent.pickContestWinners(1n, [0], [90]);
    const reads = mock.read.mock.calls.map(([call]) => call.functionName);
    expect(reads).not.toContain("agenticCommerce");
    expect(reads).not.toContain("reputationMirror");
    expect(mock.write).toHaveBeenCalledTimes(1);
  });

  it("keeps the +50% gas-limit buffer on a mainnet write", async () => {
    mock.estimate.mockResolvedValue(1_000_000n);
    await new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.owner }).cancelBounty(7n);
    expect(mock.write).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "cancelBounty", args: [7n], gas: 1_500_000n }),
    );
  });

  it("refuses to sign against a wrong chain", async () => {
    mock.chain.mockResolvedValue(10143);
    await expect(
      new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.owner }).cancelBounty(7n),
    ).rejects.toThrow("Wrong Monad RPC chain");
    expect(mock.write).not.toHaveBeenCalled();
  });
});
