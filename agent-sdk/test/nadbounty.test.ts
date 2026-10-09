import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeEventTopics, encodeAbiParameters } from "viem";
import { NadBountyAgent, MONAD_NETWORKS, type NadBountyCreateParams } from "../src/NadBountyAgent.js";
import { BOUNTY_ADAPTER_V48_ABI } from "../src/abi-v48.js";

const mock = vi.hoisted(() => ({ chain: vi.fn(), read: vi.fn(), estimate: vi.fn(), wait: vi.fn(), write: vi.fn() }));
vi.mock("viem", async importOriginal => ({ ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: vi.fn(() => ({ getChainId: mock.chain, readContract: mock.read, estimateContractGas: mock.estimate, waitForTransactionReceipt: mock.wait })),
}));
vi.mock("../src/signers/viemSigner.js", () => ({ ViemSigner: class { address = "0x0000000000000000000000000000000000000001"; writeContract = mock.write; } }));
const adapter = "0x0000000000000000000000000000000000000048" as const;
const caller = "0x0000000000000000000000000000000000000001";
const config = { network: "monad-testnet", privateKey: `0x${"01".repeat(32)}`, bountyAdapterAddress: adapter } as const;
const hash = `0x${"ab".repeat(32)}`;
const params: NadBountyCreateParams = { provider: "0x0000000000000000000000000000000000000000", reward: 10_000_000n, deadline: 2_000_000_000n, ipfsDescHash: "ipfs://description", category: "dev", tags: [], agentOnly: false, humanOnly: false, requireWorkerBond: false, contest: true, maxEntries: 10, winners: 2, minJobs: 0n, minAvgScore: 0 };
let allowance: bigint;
beforeEach(() => {
  vi.clearAllMocks(); allowance = 1_000_000_000n;
  mock.chain.mockResolvedValue(10143); mock.estimate.mockResolvedValue(101n); mock.write.mockResolvedValue(hash);
  mock.wait.mockResolvedValue({ status: "success", transactionHash: hash, logs: [] });
  mock.read.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "usdc") return MONAD_NETWORKS["monad-testnet"].usdc;
    if (functionName === "identityRegistry") return MONAD_NETWORKS["monad-testnet"].identity;
    if (functionName === "reputationRegistry") return MONAD_NETWORKS["monad-testnet"].reputation;
    if (functionName === "ownerOf") return "0x0000000000000000000000000000000000000002";
    if (functionName === "getAgentWallet") return caller;
    if (functionName === "allowance") return allowance;
    if (functionName === "getBountyMeta") return { reward: 10_000_000n, requireWorkerBond: true };
    throw new Error(`Unexpected read ${functionName}`);
  });
});
describe("NadBounty V4.8 client", () => {
  it('serves public reads without creating a signing wallet and blocks all writes', async () => {
    const agent = new NadBountyAgent({ network: 'monad-testnet', bountyAdapterAddress: adapter });
    await agent.getBounty(1n);
    await expect(agent.pickContestWinners(1n, [0], [90])).rejects.toThrow('private key is required');
    await expect(agent.createBounty(params)).rejects.toThrow('private key is required');
    expect(mock.write).not.toHaveBeenCalled();
  });
  it("uses Monad configuration and requires an explicit nonzero adapter", () => {
    expect(new NadBountyAgent(config).network.chainId).toBe(10143);
    expect(new NadBountyAgent({ ...config, network: "monad-mainnet" }).network.chainId).toBe(143);
    expect(() => new NadBountyAgent({ ...config, bountyAdapterAddress: "0x0000000000000000000000000000000000000000" })).toThrow("nonzero");
  });
  it("accepts current working wallets and includes a rounded-up 50% gas buffer", async () => {
    const agent = new NadBountyAgent(config);
    await agent.enterContest(99n, 1n, "ipfs://encrypted");
    expect(mock.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "enterContest", args: [99n, 1n, "ipfs://encrypted"], gas: 152n }));
  });
  it("does not cache authorization after wallet rotation", async () => {
    const agent = new NadBountyAgent(config); await agent.enterContest(99n, 1n, "ipfs://first");
    const base = mock.read.getMockImplementation()!;
    mock.read.mockImplementation(p => p.functionName === "getAgentWallet" ? Promise.resolve("0x0000000000000000000000000000000000000003") : base(p));
    await expect(agent.enterContest(100n, 1n, "ipfs://second")).rejects.toThrow("neither current owner");
    expect(mock.write).toHaveBeenCalledTimes(1);
  });
  it("never signs against a wrong RPC chain or mismatched immutable dependencies", async () => {
    mock.chain.mockResolvedValue(143);
    await expect(new NadBountyAgent(config).pickContestWinners(99n, [0], [90])).rejects.toThrow("Wrong Monad RPC");
    expect(mock.write).not.toHaveBeenCalled();
    mock.chain.mockResolvedValue(10143); mock.read.mockResolvedValue(adapter);
    await expect(new NadBountyAgent(config).pickContestWinners(99n, [0], [90])).rejects.toThrow("mismatch");
    expect(mock.write).not.toHaveBeenCalled();
  });
  it("fails closed on gas estimation errors and rejects reverted receipts", async () => {
    mock.estimate.mockRejectedValueOnce(new Error("estimate failed"));
    await expect(new NadBountyAgent(config).pickContestWinners(99n, [0], [90])).rejects.toThrow("estimate failed");
    expect(mock.write).not.toHaveBeenCalled();
    mock.wait.mockResolvedValueOnce({ status: "reverted", transactionHash: hash });
    await expect(new NadBountyAgent(config).pickContestWinners(99n, [0], [90])).rejects.toThrow("transaction reverted");
  });
  it("approves the actual 15% worker bond before a single-taker take", async () => {
    allowance = 0n;
    mock.write.mockImplementation(async ({ functionName, args }) => { if (functionName === "approve") allowance = args[1]; return hash; });
    await new NadBountyAgent(config).takeBounty(99n, 1n);
    expect(mock.write.mock.calls[0][0]).toMatchObject({ functionName: "approve", args: [adapter, 1_500_000n] });
    expect(mock.write.mock.calls[1][0]).toMatchObject({ functionName: "takeBounty" });
  });
  it("decodes the created job only from the configured adapter", async () => {
    const topics = encodeEventTopics({ abi: BOUNTY_ADAPTER_V48_ABI, eventName: "BountyCreated", args: { jobId: 48n, poster: caller as `0x${string}` } });
    const data = encodeAbiParameters([{ type: "uint256" }, { type: "string" }, { type: "uint256" }], [params.reward, params.category, params.deadline]);
    mock.wait.mockResolvedValueOnce({ status: "success", transactionHash: hash, logs: [{ address: adapter, topics, data }] });
    expect((await new NadBountyAgent(config).createBounty(params)).jobId).toBe(48n);
  });
});
