import {
  createPublicClient, defineChain, http, isAddress, decodeEventLog, parseAbi,
  type Address, type Hash, type ContractFunctionArgs, type TransactionReceipt,
} from "viem";
import { BOUNTY_ADAPTER_V48_ABI } from "./abi-v48.js";
import { workerBondFor } from "./logic.js";
import { ERC20_ABI } from "./abi.js";
import { ViemSigner } from "./signers/viemSigner.js";

export type MonadNetworkName = "monad-mainnet" | "monad-testnet";
export const MONAD_NETWORKS = {
  "monad-mainnet": {
    chainId: 143, rpcUrl: "https://rpc.monad.xyz", explorerUrl: "https://monadscan.com",
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  },
  "monad-testnet": {
    chainId: 10143, rpcUrl: "https://testnet-rpc.monad.xyz", explorerUrl: "https://testnet.monadscan.com",
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  },
} as const;
export type NadBountyCreateParams = ContractFunctionArgs<typeof BOUNTY_ADAPTER_V48_ABI, "nonpayable", "createBounty">[0];
export type NadBountyAgentConfig = {
  network: MonadNetworkName;
  /** Omit for a genuinely read-only client: no burner signing key is created. */
  privateKey?: Hash;
  /** Explicit deployment address: never falls back to an Arc/Base environment variable. */
  bountyAdapterAddress: Address;
  rpcUrl?: string;
};
const IDENTITY_ABI = parseAbi([
  "function ownerOf(uint256) view returns(address)",
  "function getAgentWallet(uint256) view returns(address)",
]);

/** V4.8 client. A separate ABI keeps deployed V4.7 tuple layouts compatible. */
export class NadBountyAgent {
  readonly network;
  readonly address: Address;
  readonly bountyAdapter: Address;
  private readonly publicClient;
  private readonly signer?: ViemSigner;

  constructor(config: NadBountyAgentConfig) {
    const network = MONAD_NETWORKS[config.network];
    if (!network) throw new Error("Expected monad-mainnet or monad-testnet");
    if (!isAddress(config.bountyAdapterAddress) || /^0x0+$/i.test(config.bountyAdapterAddress)) {
      throw new Error("An explicit nonzero V4.8 adapter address is required");
    }
    this.network = { ...network, rpcUrl: config.rpcUrl ?? network.rpcUrl };
    this.bountyAdapter = config.bountyAdapterAddress;
    const chain = defineChain({ id: network.chainId, name: config.network,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [this.network.rpcUrl] } },
    });
    this.publicClient = createPublicClient({ chain, transport: http(this.network.rpcUrl) });
    this.signer = config.privateKey ? new ViemSigner(config.privateKey, chain, this.network.rpcUrl) : undefined;
    this.address = this.signer?.address ?? '0x0000000000000000000000000000000000000000';
  }

  /** Every write checks the RPC and immutable dependencies before estimation/signing. */
  private async assertDeployment(): Promise<void> {
    if (await this.publicClient.getChainId() !== this.network.chainId) throw new Error("Wrong Monad RPC chain");
    for (const [functionName, expected] of [
      ["usdc", this.network.usdc], ["identityRegistry", this.network.identity], ["reputationRegistry", this.network.reputation],
    ] as const) {
      const actual = await this.publicClient.readContract({ address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI, functionName });
      if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`V4.8 ${functionName} mismatch`);
    }
  }

  /** Current authorization is read each time; revoked working keys are never cached. */
  async identityOwner(agentId: bigint): Promise<Address> {
    return this.publicClient.readContract({ address: this.network.identity, abi: IDENTITY_ABI,
      functionName: "ownerOf", args: [agentId] });
  }
  private async assertWorker(agentId: bigint): Promise<void> {
    if (agentId === 0n) return;
    const owner = await this.identityOwner(agentId);
    if (owner.toLowerCase() === this.address.toLowerCase()) return;
    const working = await this.publicClient.readContract({ address: this.network.identity,
      abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [agentId] });
    if (working.toLowerCase() !== this.address.toLowerCase()) throw new Error("Caller is neither current owner nor working wallet");
  }

  private async receipt(hash: Hash): Promise<TransactionReceipt> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`Monad transaction reverted: ${hash}`);
    return receipt;
  }
  private async write(functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    if (!this.signer) throw new Error('A private key is required for NadBounty writes');
    await this.assertDeployment();
    // Fail on estimation errors. Falling back would silently lose the reputation gas buffer.
    const estimated = await this.publicClient.estimateContractGas({ account: this.address,
      address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI,
      functionName: functionName as never, args: args as never });
    const gas = estimated + (estimated + 1n) / 2n;
    const hash = await this.signer.writeContract({ address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_V48_ABI, functionName, args, gas });
    return this.receipt(hash);
  }
  private async allowance(amount: bigint): Promise<void> {
    if (!this.signer) throw new Error('A private key is required for NadBounty writes');
    await this.assertDeployment();
    const read = () => this.publicClient.readContract({ address: this.network.usdc, abi: ERC20_ABI,
      functionName: "allowance", args: [this.address, this.bountyAdapter] });
    if (await read() >= amount) return;
    const estimated = await this.publicClient.estimateContractGas({ account: this.address,
      address: this.network.usdc, abi: ERC20_ABI, functionName: "approve", args: [this.bountyAdapter, amount] });
    await this.receipt(await this.signer.writeContract({ address: this.network.usdc, abi: ERC20_ABI,
      functionName: "approve", args: [this.bountyAdapter, amount], gas: estimated + (estimated + 1n) / 2n }));
    for (let attempt = 0; attempt < 8; ++attempt) {
      if (await read() >= amount) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("USDC approval is not yet visible to the RPC; retry before creating the bounty");
  }

  async createBounty(params: NadBountyCreateParams): Promise<{ jobId: bigint; receipt: TransactionReceipt }> {
    await this.allowance(params.reward);
    const receipt = await this.write("createBounty", [params]);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.bountyAdapter.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: BOUNTY_ADAPTER_V48_ABI, eventName: "BountyCreated", ...log });
        return { jobId: decoded.args.jobId, receipt };
      } catch { /* Ignore other adapter events. */ }
    }
    throw new Error(`Missing BountyCreated event in confirmed transaction ${receipt.transactionHash}`);
  }
  async takeBounty(jobId: bigint, agentId = 0n) {
    await this.assertWorker(agentId);
    const meta = await this.getBounty(jobId);
    if (meta.requireWorkerBond) {
      await this.allowance(workerBondFor(meta.reward));
    }
    return this.write("takeBounty", [jobId, agentId]);
  }
  autoApprove(jobId: bigint) { return this.write("autoApprove", [jobId]); }
  withdrawRejection(jobId: bigint) { return this.write("withdrawRejection", [jobId]); }
  cancelBounty(jobId: bigint) { return this.write("cancelBounty", [jobId]); }
  expireBounty(jobId: bigint) { return this.write("expireBounty", [jobId]); }
  rejectBounty(jobId: bigint, reasonCid: string) { return this.write("rejectBounty", [jobId, reasonCid]); }
  challengeRejection(jobId: bigint, evidenceCid: string) { return this.write("challengeRejection", [jobId, evidenceCid]); }
  respondToDispute(jobId: bigint, responseCid: string) { return this.write("respondToDispute", [jobId, responseCid]); }
  finalizeRejection(jobId: bigint) { return this.write("finalizeRejection", [jobId]); }
  claimDefaultRuling(jobId: bigint) { return this.write("claimDefaultRuling", [jobId]); }
  claimArbitratorTimeout(jobId: bigint) { return this.write("claimArbitratorTimeout", [jobId]); }
  resolveDispute(jobId: bigint, providerWins: boolean, rulingCid: string, penalty: number) { return this.write("resolveDispute", [jobId, providerWins, rulingCid, penalty]); }
  submitWork(jobId: bigint, cid: string) { return this.write("submitWork", [jobId, cid]); }
  approveBounty(jobId: bigint, score: number) { return this.write("approveBounty", [jobId, score]); }
  async enterContest(jobId: bigint, agentId: bigint, encryptedCid: string) {
    await this.assertWorker(agentId); return this.write("enterContest", [jobId, agentId, encryptedCid]);
  }
  replaceContestEntry(jobId: bigint, index: number, encryptedCid: string) { return this.write("replaceContestEntry", [jobId, index, encryptedCid]); }
  pickContestWinners(jobId: bigint, indices: readonly number[], scores: readonly number[]) { return this.write("pickContestWinners", [jobId, indices, scores]); }
  rejectAllContestEntries(jobId: bigint, reasonCid: string) { return this.write("rejectAllContestEntries", [jobId, reasonCid]); }
  challengeContestRejection(jobId: bigint, index: number, evidenceCid: string) { return this.write("challengeContestRejection", [jobId, index, evidenceCid]); }
  respondToContestChallenges(jobId: bigint, responseCid: string) { return this.write("respondToContestChallenges", [jobId, responseCid]); }
  acceptContestChallengers(jobId: bigint, indices: readonly number[], scores: readonly number[]) { return this.write("acceptContestChallengers", [jobId, indices, scores]); }
  resolveContestDispute(jobId: bigint, indices: readonly number[], rulingCid: string) { return this.write("resolveContestDispute", [jobId, indices, rulingCid]); }
  settleContestSilence(jobId: bigint) { return this.write("settleContestSilence", [jobId]); }
  finalizeContestRejection(jobId: bigint) { return this.write("finalizeContestRejection", [jobId]); }
  claimContestDefault(jobId: bigint) { return this.write("claimContestDefault", [jobId]); }
  claimContestArbitratorTimeout(jobId: bigint) { return this.write("claimContestArbitratorTimeout", [jobId]); }
  reconcileExpiredEscrow(jobId: bigint) { return this.write("reconcileExpiredEscrow", [jobId]); }
  withdraw() { return this.write("withdraw", []); }
  withdrawIdentity(agentId: bigint) { return this.write("withdrawIdentity", [agentId]); }
  getBounty(jobId: bigint) { return this.publicClient.readContract({ address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI, functionName: "getBountyMeta", args: [jobId] }); }
  getOpenBounties(category = '', offset = 0n, limit = 20n) {
    if (offset < 0n || limit < 1n || limit > 100n) throw new Error('Page limit must be 1..100 and offset nonnegative');
    return this.publicClient.readContract({ address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI, functionName: 'getOpenBounties', args: [category, offset, limit] });
  }
  getAgentBounties(agentId: bigint) { return this.publicClient.readContract({ address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI, functionName: 'getAgentBounties', args: [agentId] }); }
  totalBounties() { return this.publicClient.readContract({ address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI, functionName: 'totalBounties' }); }
  getContestEntries(jobId: bigint) { return this.publicClient.readContract({ address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI, functionName: "getContestEntries", args: [jobId] }); }
  getContestState(jobId: bigint) { return this.publicClient.readContract({ address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI, functionName: "getContestState", args: [jobId] }); }
  getContestChallengers(jobId: bigint) { return this.publicClient.readContract({ address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI, functionName: "getContestChallengers", args: [jobId] }); }
  getContestChallenge(jobId: bigint, index: number) { return this.publicClient.readContract({ address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI, functionName: "getContestChallenge", args: [jobId, index] }); }
  getIdentityReputation(agentId: bigint, humanWallet: Address = this.address) { return this.publicClient.readContract({ address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI, functionName: "getIdentityReputation", args: [agentId, humanWallet] }); }
}
