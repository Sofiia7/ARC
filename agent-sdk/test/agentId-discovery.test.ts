import { describe, expect, it, vi } from "vitest";
import { numberToHex, pad, type Address } from "viem";
import { ArcBountyAgent } from "../src/ArcBountyAgent.js";
import { NETWORKS, resolveNetwork } from "../src/constants.js";

// Offline: the agent's public client and signer are replaced by fakes, so
// nothing here touches a network or signs anything real.
const KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ADAPTER = "0x9b0B27c20DF10BFc667F4316d7175166Ff8c4c2c";
const OTHER = "0x00000000000000000000000000000000000000aa" as Address;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = pad("0x0", { size: 32 });

type GetLogsArgs = { fromBlock: bigint; toBlock: bigint; args: { to?: Address; from?: Address } };
type Fake = {
  balance: bigint | Error;
  head?: bigint;
  /** Transfers to self, by block: [block, tokenId]. */
  transfers?: [bigint, bigint][];
  /** tokenId -> current holder (default: self). */
  owners?: Map<bigint, Address>;
  getLogsError?: Error;
};

function setup(network: "base-mainnet" | "base-sepolia" | "arc-mainnet", fake: Fake) {
  const agent = new ArcBountyAgent({ network, privateKey: KEY, bountyAdapterAddress: ADAPTER } as ConstructorParameters<typeof ArcBountyAgent>[0]);
  const self = agent.address;
  const registry = resolveNetwork(network).contracts.IDENTITY_REGISTRY;
  const getLogsCalls: GetLogsArgs[] = [];
  const client = {
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === "balanceOf") {
        if (fake.balance instanceof Error) throw fake.balance;
        expect(args[0]).toBe(self);
        return fake.balance;
      }
      if (functionName === "ownerOf") return fake.owners?.get(args[0] as bigint) ?? self;
      throw new Error(`unexpected readContract ${functionName}`);
    }),
    getBlockNumber: vi.fn(async () => fake.head ?? 10_000_000n),
    getLogs: vi.fn(async (p: GetLogsArgs) => {
      getLogsCalls.push(p);
      if (fake.getLogsError) throw fake.getLogsError;
      expect(p.args).toEqual({ to: self });
      return (fake.transfers ?? [])
        .filter(([block]) => block >= p.fromBlock && block <= p.toBlock)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([block, tokenId]) => ({ blockNumber: block, args: { from: OTHER, to: self, tokenId } }));
    }),
    waitForTransactionReceipt: vi.fn(async () => ({
      status: "success",
      logs: [{
        address: registry,
        topics: [TRANSFER, ZERO_TOPIC, pad(self.toLowerCase() as Address, { size: 32 }), numberToHex(777n, { size: 32 })],
      }],
    })),
  };
  (agent as unknown as { publicClient: typeof client }).publicClient = client;
  const writeContract = vi.fn(async () => "0x" + "ab".repeat(32));
  (agent as unknown as { signer: { writeContract: typeof writeContract } }).signer.writeContract = writeContract;
  return { agent, client, getLogsCalls, writeContract, self };
}

describe("register() without a pinned agentId", () => {
  // The regression: on Base, mainnet.base.org refused every 10k-block log scan,
  // so discovery always reported "scan failed" and register() refused to mint
  // for every new agent. balanceOf answers "no identity" in one call.
  it("mints for a wallet that holds no identity, with no log scan at all", async () => {
    const { agent, client, writeContract } = setup("base-mainnet", { balance: 0n });
    await expect(agent.register("ipfs://meta")).resolves.toBe(777n);
    expect(client.getLogs).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("reuses an identity the wallet already holds instead of minting a second one", async () => {
    const { agent, writeContract } = setup("base-mainnet", { balance: 1n, transfers: [[9_990_000n, 41n]] });
    await expect(agent.register()).resolves.toBe(41n);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("skips an identity that was received and then sent away", async () => {
    const owners = new Map<bigint, Address>([[50n, OTHER]]);
    const { agent } = setup("base-mainnet", { balance: 1n, owners, transfers: [[9_990_000n, 41n], [9_999_000n, 50n]] });
    await expect(agent.register()).resolves.toBe(41n);
  });

  it("refuses to mint, naming the reason, when the wallet holds an identity older than the scan", async () => {
    const { agent, writeContract } = setup("base-mainnet", { balance: 1n, transfers: [[1n, 5n]] });
    await expect(agent.register()).rejects.toThrow(/already owns 1 ERC-8004 identity on Base .*agentId/s);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("refuses to mint when the registry balance cannot be read at all", async () => {
    const { agent, writeContract } = setup("base-mainnet", { balance: new Error("429 request limit reached") });
    await expect(agent.register()).rejects.toThrow(/could not determine whether this wallet already has an agentId/);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("refuses to mint when the scan errors for a wallet that holds an identity", async () => {
    const { agent, writeContract } = setup("base-mainnet", { balance: 2n, getLogsError: new Error("range too large") });
    await expect(agent.register()).rejects.toThrow(/already owns 2 ERC-8004 identities/);
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe("log scan bounds", () => {
  it.each([
    ["base-mainnet", 50_000n],
    ["base-sepolia", 200n],
    ["arc-mainnet", 10_000n],
  ] as const)("%s asks for at most %d blocks per eth_getLogs call and stops at the call budget", async (network, range) => {
    const { agent, getLogsCalls } = setup(network, { balance: 1n, transfers: [] });
    await expect(agent.resolveAgentId()).resolves.toBeNull();
    expect(getLogsCalls.length).toBeGreaterThan(0);
    expect(getLogsCalls.length).toBeLessThanOrEqual(24);
    for (const call of getLogsCalls) expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(range);
    // Contiguous, newest first, no gaps between chunks.
    for (let i = 1; i < getLogsCalls.length; i++) expect(getLogsCalls[i]!.toBlock).toBe(getLogsCalls[i - 1]!.fromBlock - 1n);
  });
});

describe("network read fallbacks", () => {
  it("Base mainnet carries publicnode as a read fallback; Arc has none", () => {
    expect(NETWORKS["base-mainnet"].fallbackRpcUrls).toEqual(["https://base-rpc.publicnode.com"]);
    expect(resolveNetwork("base-mainnet", { BASE_MAINNET_RPC_URL: "https://example.invalid/rpc" }).fallbackRpcUrls)
      .toEqual(["https://base-rpc.publicnode.com"]);
    expect(resolveNetwork("arc-mainnet").fallbackRpcUrls).toBeUndefined();
  });
});
