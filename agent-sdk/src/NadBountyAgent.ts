import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  isAddress,
  parseAbi,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionReturnType,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { BOUNTY_ADAPTER_V48_ABI } from "./abi-v48.js";
import { REPUTATION_MIRROR_ABI } from "./reputationMirrorAbi.js";
import { workerBondFor } from "./logic.js";
import { ERC20_ABI } from "./abi.js";
import { ViemSigner } from "./signers/viemSigner.js";
import { MONAD_MULTICALL3, MONAD_NETWORKS, type MonadNetworkConfig, type MonadNetworkName } from "./constants.js";
import { fetchIpfsText, pinTextAuto, type PinViaSiteOptions } from "./ipfs.js";
import {
  AGENT_WALLET_MAX_DEADLINE_DELAY_SEC,
  MONAD_IDENTITY_REGISTRY_ABI,
  agentWalletTypedData,
  identityKey as computeIdentityKey,
  isZeroAddress,
  type AgentWalletConsent,
} from "./nadIdentity.js";
import { toNadError } from "./nadErrors.js";
import { validateNadCreateParams } from "./nadParams.js";
import {
  createDescription,
  parseNadDescription,
  pinContestEntry as pinEncryptedEntry,
  serializeDescription,
  type CreateDescriptionInput,
  type ParsedNadDescription,
} from "./nadDescription.js";
import { computePendingActions, type NadPendingAction, type NadPendingJob, type NadPendingMeta } from "./nadPending.js";

// Kept here so `import { MONAD_NETWORKS } from "./NadBountyAgent.js"` keeps working.
export { MONAD_NETWORKS, type MonadNetworkName } from "./constants.js";

export type NadBountyCreateParams = ContractFunctionArgs<
  typeof BOUNTY_ADAPTER_V48_ABI,
  "nonpayable",
  "createBounty"
>[0];
/** The adapter's `BountyMeta` struct as returned by `getBounty`. */
export type NadBountyMeta = ContractFunctionReturnType<typeof BOUNTY_ADAPTER_V48_ABI, "view", "getBountyMeta">;
export type NadAgentReputation = ContractFunctionReturnType<
  typeof BOUNTY_ADAPTER_V48_ABI,
  "view",
  "getAgentReputation"
>;

export type NadBountyAgentConfig = {
  network: MonadNetworkName;
  /** Omit for a genuinely read-only client: no burner signing key is created. */
  privateKey?: Hash;
  /**
   * The V4.8 adapter. Optional on "monad-mainnet", which has a built-in canonical
   * deployment (MONAD_NETWORKS["monad-mainnet"].defaultBountyAdapter); required on
   * "monad-testnet". Never falls back to an Arc/Base environment variable.
   */
  bountyAdapterAddress?: Address;
  rpcUrl?: string;
};

/** Paid jobs and score sum of one identity (the adapter keeps no averages). */
export type NadReputationTotals = { paidJobs: bigint; scoreSum: bigint };
/** One source-chain snapshot in the ReputationMirror. */
export type NadMirrorRecord = { paidJobs: bigint; scoreSum: bigint; sourceBlock: bigint; updatedAt: bigint };
/** The chains the mirror accepts snapshots from (equal to the contract's BASE_CHAIN_ID and ARC_CHAIN_ID). */
export const MIRROR_SOURCE_CHAINS = { base: 8453n, arc: 5042n } as const;

export type NadIdentity = { owner: Address; workingWallet: Address };
export type NadPendingWithdrawals = {
  /** USDC parked for the address after a failed direct payout; claim with `withdraw()`. */
  address: bigint;
  /** USDC parked for the identity; claim with `withdrawIdentity(agentId)` as the identity owner. */
  identity: bigint;
};

const ESCROW_ABI = parseAbi([
  "function getJob(uint256) view returns ((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))",
]);
/** AgenticCommerce JobStatus.Expired. */
const ESCROW_EXPIRED = 5;
/** The adapter creates the escrow job with expiredAt = deadline + 90 days (AC_EXPIRY_BUFFER). */
const AC_EXPIRY_BUFFER = 90n * 86_400n;
/** Calls per Multicall3 request; keeps one eth_call well under public-RPC gas limits. */
const MULTICALL_CHUNK = 40;

type BatchCall = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

/**
 * V4.8 client for NadBounty on Monad. A separate ABI keeps deployed V4.7 tuple
 * layouts compatible. Every thrown viem error is rewritten into a readable
 * `NadBountyError`; RPC URLs never appear in error text.
 */
export class NadBountyAgent {
  readonly network: MonadNetworkConfig & { rpcUrl: string };
  readonly networkName: MonadNetworkName;
  readonly address: Address;
  readonly bountyAdapter: Address;
  private readonly publicClient;
  private readonly signer?: ViemSigner;
  /** True when `bountyAdapter` is the built-in canonical deployment, whose escrow and mirror are known. */
  private readonly canonical: boolean;
  private escrowAddress?: Address;
  private mirrorAddress?: Address;

  constructor(config: NadBountyAgentConfig) {
    const network = Object.prototype.hasOwnProperty.call(MONAD_NETWORKS, config.network)
      ? MONAD_NETWORKS[config.network]
      : undefined;
    if (!network) throw new Error("Expected monad-mainnet or monad-testnet");
    const adapter = config.bountyAdapterAddress ?? network.defaultBountyAdapter;
    if (!adapter || !isAddress(adapter) || isZeroAddress(adapter)) {
      throw new Error(
        "An explicit nonzero V4.8 adapter address is required" +
          (network.defaultBountyAdapter ? "" : ` on ${config.network} (no built-in deployment)`),
      );
    }
    this.networkName = config.network;
    this.network = { ...network, rpcUrl: config.rpcUrl ?? network.rpcUrl };
    this.bountyAdapter = adapter;
    this.canonical =
      network.defaultBountyAdapter !== undefined &&
      adapter.toLowerCase() === network.defaultBountyAdapter.toLowerCase();
    const chain = defineChain({
      id: network.chainId,
      name: config.network,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [this.network.rpcUrl] } },
      contracts: { multicall3: { address: MONAD_MULTICALL3 } },
    });
    this.publicClient = createPublicClient({ chain, transport: http(this.network.rpcUrl) });
    this.signer = config.privateKey ? new ViemSigner(config.privateKey, chain, this.network.rpcUrl) : undefined;
    this.address = this.signer?.address ?? "0x0000000000000000000000000000000000000000";
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  /** Run an RPC-touching step; viem errors come out as readable NadBountyErrors without the RPC URL. */
  private async rpc<T>(context: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw toNadError(error, context);
    }
  }

  private requireSigner(): ViemSigner {
    if (!this.signer) throw new Error("A private key is required for NadBounty writes");
    return this.signer;
  }

  /** A caller-supplied or default address, never the zero address of a read-only client. */
  private requireAddress(value: Address | undefined, method: string): Address {
    const address = value ?? this.address;
    if (!isAddress(address)) throw new Error(`${method}: not a valid address`);
    if (isZeroAddress(address)) {
      throw new Error(
        `${method}: this client has no private key, so there is no default address. Pass one explicitly.`,
      );
    }
    return address;
  }

  private async assertChain(): Promise<void> {
    const chainId = await this.rpc("verify RPC chain", () => this.publicClient.getChainId());
    if (chainId !== this.network.chainId) throw new Error("Wrong Monad RPC chain");
  }

  /** Every write checks the RPC and immutable dependencies before estimation/signing. */
  private async assertDeployment(): Promise<void> {
    await this.assertChain();
    const expectations: (readonly [string, Address | undefined])[] = [
      ["usdc", this.network.usdc],
      ["identityRegistry", this.network.identity],
      ["reputationRegistry", this.network.reputation],
    ];
    // The escrow and mirror are specific to the canonical deployment; a custom adapter brings its own.
    if (this.canonical) {
      expectations.push(
        ["agenticCommerce", this.network.agenticCommerce],
        ["reputationMirror", this.network.reputationMirror],
      );
    }
    for (const [functionName, expected] of expectations) {
      if (!expected) continue;
      const actual = await this.rpc("verify deployment", () =>
        this.publicClient.readContract({
          address: this.bountyAdapter,
          abi: BOUNTY_ADAPTER_V48_ABI,
          functionName: functionName as "usdc",
        }),
      );
      if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`V4.8 ${functionName} mismatch`);
    }
  }

  /** Batched reads through Multicall3: one eth_call per chunk. Any failing call fails the batch. */
  private async batch(calls: readonly BatchCall[], context: string): Promise<unknown[]> {
    const results: unknown[] = [];
    for (let start = 0; start < calls.length; start += MULTICALL_CHUNK) {
      const chunk = calls.slice(start, start + MULTICALL_CHUNK);
      const part = await this.rpc(context, () =>
        this.publicClient.multicall({
          allowFailure: false,
          batchSize: 32_768,
          contracts: chunk.map((call) => ({
            address: call.address,
            abi: call.abi,
            functionName: call.functionName,
            args: call.args ?? [],
          })) as never,
        }),
      );
      results.push(...(part as unknown[]));
    }
    return results;
  }
  private adapterCall(functionName: string, args: readonly unknown[] = []): BatchCall {
    return { address: this.bountyAdapter, abi: BOUNTY_ADAPTER_V48_ABI as unknown as Abi, functionName, args };
  }

  private async receipt(hash: Hash): Promise<TransactionReceipt> {
    const receipt = await this.rpc("waiting for the transaction", () =>
      this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }),
    );
    if (receipt.status !== "success") {
      throw new Error(
        `Monad transaction reverted: ${hash} (${this.network.explorerUrl}/tx/${hash}). ` +
          "It was estimated to succeed, so the state most likely changed before it was included; re-read the bounty and retry.",
      );
    }
    return receipt;
  }

  /** Estimate, add the +50% limit buffer (Monad bills the gas limit), sign, send and wait. */
  private async send(
    target: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ): Promise<TransactionReceipt> {
    const signer = this.requireSigner();
    // Fail on estimation errors. Falling back would silently lose the reputation gas buffer.
    const estimated = await this.rpc(functionName, () =>
      this.publicClient.estimateContractGas({
        account: this.address,
        address: target,
        abi,
        functionName: functionName as never,
        args: args as never,
      }),
    );
    const gas = estimated + (estimated + 1n) / 2n;
    const hash = await this.rpc(functionName, () =>
      signer.writeContract({ address: target, abi, functionName, args, gas }),
    );
    return this.receipt(hash);
  }

  private async write(functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    this.requireSigner();
    await this.assertDeployment();
    return this.send(this.bountyAdapter, BOUNTY_ADAPTER_V48_ABI as unknown as Abi, functionName, args);
  }

  private async allowance(amount: bigint): Promise<void> {
    const signer = this.requireSigner();
    await this.assertDeployment();
    const read = () =>
      this.rpc("allowance", () =>
        this.publicClient.readContract({
          address: this.network.usdc,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [this.address, this.bountyAdapter],
        }),
      );
    if ((await read()) >= amount) return;
    const estimated = await this.rpc("approve", () =>
      this.publicClient.estimateContractGas({
        account: this.address,
        address: this.network.usdc,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [this.bountyAdapter, amount],
      }),
    );
    await this.receipt(
      await this.rpc("approve", () =>
        signer.writeContract({
          address: this.network.usdc,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [this.bountyAdapter, amount],
          gas: estimated + (estimated + 1n) / 2n,
        }),
      ),
    );
    for (let attempt = 0; attempt < 8; ++attempt) {
      if ((await read()) >= amount) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("USDC approval is not yet visible to the RPC; retry before creating the bounty");
  }

  // ─── Identity (canonical ERC-8004 registry) ────────────────────────────────

  /** Current authorization is read each time; revoked working keys are never cached. */
  async identityOwner(agentId: bigint): Promise<Address> {
    return this.rpc("identityOwner", () =>
      this.publicClient.readContract({
        address: this.network.identity,
        abi: MONAD_IDENTITY_REGISTRY_ABI,
        functionName: "ownerOf",
        args: [agentId],
      }),
    );
  }

  private async assertWorker(agentId: bigint): Promise<void> {
    if (agentId === 0n) return;
    const owner = await this.identityOwner(agentId);
    if (owner.toLowerCase() === this.address.toLowerCase()) return;
    const working = await this.rpc("getAgentWallet", () =>
      this.publicClient.readContract({
        address: this.network.identity,
        abi: MONAD_IDENTITY_REGISTRY_ABI,
        functionName: "getAgentWallet",
        args: [agentId],
      }),
    );
    if (working.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error("Caller is neither current owner nor working wallet");
    }
  }

  /**
   * Mint an ERC-8004 identity owned by this wallet. With a URI it registers
   * `register(string)`, otherwise `register()`. The new agentId comes from the
   * registry's `Registered` event (or the mint `Transfer`) in the receipt.
   * A fresh identity's working wallet is its owner until you set another.
   *
   * @param metadataUri an `ipfs://` agent card, for example from `pinAgentMetadata`.
   */
  async registerIdentity(metadataUri = ""): Promise<{ agentId: bigint; hash: Hash; receipt: TransactionReceipt }> {
    this.requireSigner();
    await this.assertChain();
    const receipt = await this.send(
      this.network.identity,
      MONAD_IDENTITY_REGISTRY_ABI as unknown as Abi,
      "register",
      metadataUri ? [metadataUri] : [],
    );
    const me = this.address.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.network.identity.toLowerCase()) continue;
      try {
        const registered = decodeEventLog({ abi: MONAD_IDENTITY_REGISTRY_ABI, eventName: "Registered", ...log });
        if (registered.args.owner.toLowerCase() === me) {
          return { agentId: registered.args.agentId, hash: receipt.transactionHash, receipt };
        }
      } catch {
        /* not a Registered log */
      }
    }
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.network.identity.toLowerCase()) continue;
      try {
        const mint = decodeEventLog({ abi: MONAD_IDENTITY_REGISTRY_ABI, eventName: "Transfer", ...log });
        if (/^0x0{40}$/i.test(mint.args.from) && mint.args.to.toLowerCase() === me) {
          return { agentId: mint.args.tokenId, hash: receipt.transactionHash, receipt };
        }
      } catch {
        /* not a Transfer log */
      }
    }
    throw new Error(`Missing Registered event in confirmed transaction ${receipt.transactionHash}`);
  }

  /** Owner and current working wallet of an identity. Throws a readable error if the agentId does not exist. */
  async getIdentity(agentId: bigint): Promise<NadIdentity> {
    const [owner, workingWallet] = (await this.batch(
      [
        {
          address: this.network.identity,
          abi: MONAD_IDENTITY_REGISTRY_ABI as unknown as Abi,
          functionName: "ownerOf",
          args: [agentId],
        },
        {
          address: this.network.identity,
          abi: MONAD_IDENTITY_REGISTRY_ABI as unknown as Abi,
          functionName: "getAgentWallet",
          args: [agentId],
        },
      ],
      "getIdentity",
    )) as [Address, Address];
    return { owner, workingWallet };
  }

  /**
   * Step 1 of 2 for giving an identity a working wallet. Run it on a client
   * built with the WORKING wallet's key: that wallet signs an EIP-712
   * `AgentWalletSet` consent naming the identity, the owner and a deadline.
   * Hand the result to the owner, who calls {@link setAgentWallet} (step 2).
   *
   * The registry accepts a deadline at most 5 minutes ahead, so the default is
   * 300 seconds from the latest block; submit promptly or sign again.
   */
  async signAgentWalletConsent(opts: {
    agentId: bigint;
    owner: Address;
    deadline?: bigint;
  }): Promise<AgentWalletConsent> {
    const signer = this.requireSigner();
    if (!signer.signTypedData)
      throw new Error("This signer cannot sign typed data, so it cannot authorize a working wallet");
    if (typeof opts.agentId !== "bigint" || opts.agentId <= 0n) throw new Error("agentId must be a positive bigint");
    if (!isAddress(opts.owner) || isZeroAddress(opts.owner))
      throw new Error("owner must be the identity owner's address");
    const now = (await this.rpc("signAgentWalletConsent", () => this.publicClient.getBlock())).timestamp;
    const deadline = opts.deadline ?? now + AGENT_WALLET_MAX_DEADLINE_DELAY_SEC;
    if (deadline <= now) throw new Error("The consent deadline is already in the past");
    if (deadline > now + AGENT_WALLET_MAX_DEADLINE_DELAY_SEC) {
      throw new Error("The registry rejects a consent deadline more than 5 minutes ahead");
    }
    const signature = await signer.signTypedData(
      agentWalletTypedData({
        chainId: this.network.chainId,
        registry: this.network.identity,
        agentId: opts.agentId,
        newWallet: this.address,
        owner: opts.owner,
        deadline,
      }),
    );
    return { agentId: opts.agentId, newWallet: this.address, owner: opts.owner, deadline, signature };
  }

  /**
   * Step 2 of 2: the identity OWNER registers the working wallet using the
   * consent from {@link signAgentWalletConsent}. A working wallet can take
   * bounties and enter contests for the identity but never withdraw earnings:
   * payouts always go to the owner. Setting a new wallet revokes the old one.
   */
  async setAgentWallet(agentId: bigint, consent: AgentWalletConsent): Promise<TransactionReceipt> {
    this.requireSigner();
    if (consent.agentId !== agentId) throw new Error("This consent was signed for a different agentId");
    if (consent.owner.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error(`This consent names ${consent.owner} as owner, but this client is ${this.address}`);
    }
    await this.assertChain();
    const owner = await this.identityOwner(agentId);
    if (owner.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error(`Only the identity owner (${owner}) can set the working wallet`);
    }
    const now = (await this.rpc("setAgentWallet", () => this.publicClient.getBlock())).timestamp;
    if (consent.deadline < now)
      throw new Error("The wallet consent has expired. Ask the working wallet to sign a new one.");
    return this.send(this.network.identity, MONAD_IDENTITY_REGISTRY_ABI as unknown as Abi, "setAgentWallet", [
      agentId,
      consent.newWallet,
      consent.deadline,
      consent.signature,
    ]);
  }

  /** Same as {@link setAgentWallet}. */
  setWorkingWallet(agentId: bigint, consent: AgentWalletConsent): Promise<TransactionReceipt> {
    return this.setAgentWallet(agentId, consent);
  }

  /** Owner only: remove the working wallet (for example after its key leaked). */
  async unsetAgentWallet(agentId: bigint): Promise<TransactionReceipt> {
    this.requireSigner();
    await this.assertChain();
    const owner = await this.identityOwner(agentId);
    if (owner.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error(`Only the identity owner (${owner}) can remove the working wallet`);
    }
    return this.send(this.network.identity, MONAD_IDENTITY_REGISTRY_ABI as unknown as Abi, "unsetAgentWallet", [
      agentId,
    ]);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  async createBounty(params: NadBountyCreateParams): Promise<{ jobId: bigint; receipt: TransactionReceipt }> {
    this.requireSigner();
    validateNadCreateParams(params, BigInt(Math.floor(Date.now() / 1000)));
    await this.allowance(params.reward);
    const receipt = await this.write("createBounty", [params]);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.bountyAdapter.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: BOUNTY_ADAPTER_V48_ABI, eventName: "BountyCreated", ...log });
        return { jobId: decoded.args.jobId, receipt };
      } catch {
        /* Ignore other adapter events. */
      }
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
  autoApprove(jobId: bigint) {
    return this.write("autoApprove", [jobId]);
  }
  withdrawRejection(jobId: bigint) {
    return this.write("withdrawRejection", [jobId]);
  }
  cancelBounty(jobId: bigint) {
    return this.write("cancelBounty", [jobId]);
  }
  expireBounty(jobId: bigint) {
    return this.write("expireBounty", [jobId]);
  }
  rejectBounty(jobId: bigint, reasonCid: string) {
    return this.write("rejectBounty", [jobId, reasonCid]);
  }
  challengeRejection(jobId: bigint, evidenceCid: string) {
    return this.write("challengeRejection", [jobId, evidenceCid]);
  }
  /** Single-taker dispute by the poster or the worker, on a submission that is not rejected (use challengeRejection after a rejection). */
  disputeBounty(jobId: bigint, reasonCid: string) {
    return this.write("disputeBounty", [jobId, reasonCid]);
  }
  respondToDispute(jobId: bigint, responseCid: string) {
    return this.write("respondToDispute", [jobId, responseCid]);
  }
  finalizeRejection(jobId: bigint) {
    return this.write("finalizeRejection", [jobId]);
  }
  claimDefaultRuling(jobId: bigint) {
    return this.write("claimDefaultRuling", [jobId]);
  }
  claimArbitratorTimeout(jobId: bigint) {
    return this.write("claimArbitratorTimeout", [jobId]);
  }
  resolveDispute(jobId: bigint, providerWins: boolean, rulingCid: string, penalty: number) {
    return this.write("resolveDispute", [jobId, providerWins, rulingCid, penalty]);
  }
  submitWork(jobId: bigint, cid: string) {
    return this.write("submitWork", [jobId, cid]);
  }
  approveBounty(jobId: bigint, score: number) {
    return this.write("approveBounty", [jobId, score]);
  }
  async enterContest(jobId: bigint, agentId: bigint, encryptedCid: string) {
    await this.assertWorker(agentId);
    return this.write("enterContest", [jobId, agentId, encryptedCid]);
  }
  replaceContestEntry(jobId: bigint, index: number, encryptedCid: string) {
    return this.write("replaceContestEntry", [jobId, index, encryptedCid]);
  }
  pickContestWinners(jobId: bigint, indices: readonly number[], scores: readonly number[]) {
    return this.write("pickContestWinners", [jobId, indices, scores]);
  }
  rejectAllContestEntries(jobId: bigint, reasonCid: string) {
    return this.write("rejectAllContestEntries", [jobId, reasonCid]);
  }
  challengeContestRejection(jobId: bigint, index: number, evidenceCid: string) {
    return this.write("challengeContestRejection", [jobId, index, evidenceCid]);
  }
  respondToContestChallenges(jobId: bigint, responseCid: string) {
    return this.write("respondToContestChallenges", [jobId, responseCid]);
  }
  acceptContestChallengers(jobId: bigint, indices: readonly number[], scores: readonly number[]) {
    return this.write("acceptContestChallengers", [jobId, indices, scores]);
  }
  resolveContestDispute(jobId: bigint, indices: readonly number[], rulingCid: string) {
    return this.write("resolveContestDispute", [jobId, indices, rulingCid]);
  }
  settleContestSilence(jobId: bigint) {
    return this.write("settleContestSilence", [jobId]);
  }
  finalizeContestRejection(jobId: bigint) {
    return this.write("finalizeContestRejection", [jobId]);
  }
  claimContestDefault(jobId: bigint) {
    return this.write("claimContestDefault", [jobId]);
  }
  claimContestArbitratorTimeout(jobId: bigint) {
    return this.write("claimContestArbitratorTimeout", [jobId]);
  }
  reconcileExpiredEscrow(jobId: bigint) {
    return this.write("reconcileExpiredEscrow", [jobId]);
  }
  withdraw() {
    return this.write("withdraw", []);
  }
  withdrawIdentity(agentId: bigint) {
    return this.write("withdrawIdentity", [agentId]);
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  getBounty(jobId: bigint) {
    return this.rpc("getBounty", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getBountyMeta",
        args: [jobId],
      }),
    );
  }
  getOpenBounties(category = "", offset = 0n, limit = 20n) {
    if (offset < 0n || limit < 1n || limit > 100n) throw new Error("Page limit must be 1..100 and offset nonnegative");
    return this.rpc("getOpenBounties", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getOpenBounties",
        args: [category, offset, limit],
      }),
    );
  }
  getAgentBounties(agentId: bigint) {
    return this.rpc("getAgentBounties", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getAgentBounties",
        args: [agentId],
      }),
    );
  }
  totalBounties() {
    return this.rpc("totalBounties", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "totalBounties",
      }),
    );
  }
  getContestEntries(jobId: bigint) {
    return this.rpc("getContestEntries", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getContestEntries",
        args: [jobId],
      }),
    );
  }
  getContestState(jobId: bigint) {
    return this.rpc("getContestState", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getContestState",
        args: [jobId],
      }),
    );
  }
  getContestChallengers(jobId: bigint) {
    return this.rpc("getContestChallengers", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getContestChallengers",
        args: [jobId],
      }),
    );
  }
  getContestChallenge(jobId: bigint, index: number) {
    return this.rpc("getContestChallenge", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getContestChallenge",
        args: [jobId, index],
      }),
    );
  }

  /**
   * Paid jobs and score sum of an identity: local history plus the Base and Arc
   * snapshots of its current owner. Returns the contract's `[paidJobs, scoreSum]` tuple.
   * An agentId of 0 means a human, identified by `humanWallet`; a read-only client
   * has no default wallet, so pass one. Throws before any RPC call otherwise.
   */
  async getIdentityReputation(agentId: bigint, humanWallet: Address = this.address) {
    if (typeof agentId !== "bigint" || agentId < 0n)
      throw new RangeError("getIdentityReputation: agentId must be a nonnegative bigint");
    if (agentId === 0n) {
      if (!isAddress(humanWallet) || isZeroAddress(humanWallet)) {
        throw new Error(
          "getIdentityReputation: agentId 0 identifies a human by wallet, so pass a nonzero humanWallet " +
            "(a client without a private key has no default wallet) or pass the agentId you registered",
        );
      }
    }
    return this.rpc("getIdentityReputation", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getIdentityReputation",
        args: [agentId, humanWallet],
      }),
    );
  }

  /** Whether the adapter is paused. Paused blocks createBounty/takeBounty/enterContest only; exits and settlements stay open. */
  async isPaused(): Promise<boolean> {
    return this.rpc("isPaused", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "paused",
      }),
    );
  }
  /** Per-bounty reward cap in USDC base units (100 USDC = 100000000 at launch); 0 means uncapped. */
  async maxBountyAmount(): Promise<bigint> {
    return this.rpc("maxBountyAmount", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "maxBountyAmount",
      }),
    );
  }
  /** Protocol fee in basis points of the payout (immutable; 100 = 1%). */
  async feeBps(): Promise<bigint> {
    return this.rpc("feeBps", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "feeBps",
      }),
    );
  }
  /** USDC parked for an address after a failed direct payout; claim it with `withdraw()`. */
  async pendingWithdrawals(address?: Address): Promise<bigint> {
    const who = this.requireAddress(address, "pendingWithdrawals");
    return this.rpc("pendingWithdrawals", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "pendingWithdrawals",
        args: [who],
      }),
    );
  }
  /** USDC parked for an identity when its owner could not be resolved at settlement; claim with `withdrawIdentity(agentId)`. */
  async pendingIdentityWithdrawals(agentId: bigint): Promise<bigint> {
    if (typeof agentId !== "bigint" || agentId <= 0n)
      throw new RangeError("pendingIdentityWithdrawals: agentId must be a positive bigint");
    return this.rpc("pendingIdentityWithdrawals", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "pendingIdentityWithdrawals",
        args: [agentId],
      }),
    );
  }
  /** Both parked balances in one call. Pass an address, an agentId, or both. */
  async getPendingWithdrawals(opts: { address?: Address; agentId?: bigint } = {}): Promise<NadPendingWithdrawals> {
    const agentId = opts.agentId ?? 0n;
    const address = opts.address ?? (isZeroAddress(this.address) ? undefined : this.address);
    if (!address && agentId === 0n) throw new Error("getPendingWithdrawals: pass an address and/or an agentId");
    if (address && !isAddress(address)) throw new Error("getPendingWithdrawals: not a valid address");
    const calls: BatchCall[] = [];
    if (address) calls.push(this.adapterCall("pendingWithdrawals", [address]));
    if (agentId !== 0n) calls.push(this.adapterCall("pendingIdentityWithdrawals", [agentId]));
    const values = (await this.batch(calls, "getPendingWithdrawals")) as bigint[];
    return { address: address ? values[0]! : 0n, identity: agentId !== 0n ? values[address ? 1 : 0]! : 0n };
  }

  /**
   * The key of `localReputation` for an agent (history follows the NFT id) or a
   * human wallet. Computed locally, identical to the contract's pure function.
   */
  identityKey(agentId: bigint, humanWallet?: Address): Hex {
    return computeIdentityKey(agentId, agentId === 0n ? (humanWallet ?? this.address) : humanWallet);
  }
  /** Paid jobs and score sum recorded on this adapter for one identity (without the mirrored Base/Arc history). */
  async localReputation(identity: Hex | { agentId: bigint; humanWallet?: Address }): Promise<NadReputationTotals> {
    const key = typeof identity === "string" ? identity : this.identityKey(identity.agentId, identity.humanWallet);
    if (!/^0x[0-9a-fA-F]{64}$/.test(key))
      throw new Error("localReputation: expected a bytes32 identity key or { agentId, humanWallet }");
    const [paidJobs, scoreSum] = await this.rpc("localReputation", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "localReputation",
        args: [key as Hex],
      }),
    );
    return { paidJobs, scoreSum };
  }
  /** The canonical ERC-8004 reputation registry's summary of this adapter's feedback for an agent. */
  async getAgentReputation(agentId: bigint): Promise<NadAgentReputation> {
    if (typeof agentId !== "bigint" || agentId <= 0n)
      throw new RangeError("getAgentReputation: agentId must be a positive bigint");
    return this.rpc("getAgentReputation", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getAgentReputation",
        args: [agentId],
      }),
    );
  }
  /** How many distinct posters have paid out a completed bounty to this agent (an anti-sybil signal; humans are never counted). */
  async uniquePosterCount(agentId: bigint): Promise<bigint> {
    if (typeof agentId !== "bigint" || agentId <= 0n)
      throw new RangeError("uniquePosterCount: agentId must be a positive bigint");
    return this.rpc("uniquePosterCount", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "uniquePosterCount",
        args: [agentId],
      }),
    );
  }

  /** Job ids this poster created, oldest first. Defaults to this client's address. */
  async getMyPostedBounties(poster?: Address): Promise<readonly bigint[]> {
    const who = this.requireAddress(poster, "getMyPostedBounties");
    return this.rpc("getMyPostedBounties", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getMyPostedBounties",
        args: [who],
      }),
    );
  }
  /** Job ids this wallet took or entered, oldest first (contest entries count). Defaults to this client's address. */
  async getMyAssignedBounties(provider?: Address): Promise<readonly bigint[]> {
    const who = this.requireAddress(provider, "getMyAssignedBounties");
    return this.rpc("getMyAssignedBounties", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getMyAssignedBounties",
        args: [who],
      }),
    );
  }

  /** When a contest stopped accepting entries: unix seconds, or 0n while still open. Reverts WrongBountyMode on a single-taker bounty. */
  async contestClosedAt(jobId: bigint): Promise<bigint> {
    return this.rpc("contestClosedAt", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "contestClosedAt",
        args: [jobId],
      }),
    );
  }
  /**
   * The index of this identity's entry in a contest, or null if it has not entered.
   * (The contract returns index + 1, with 0 for "none"; this unwraps it.)
   * agentId 0 means a human entrant identified by `humanWallet`.
   */
  async getContestEntryIndex(jobId: bigint, agentId: bigint, humanWallet?: Address): Promise<number | null> {
    const wallet =
      agentId === 0n ? this.requireAddress(humanWallet, "getContestEntryIndex") : (humanWallet ?? this.address);
    const indexPlusOne = await this.rpc("getContestEntryIndex", () =>
      this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_V48_ABI,
        functionName: "getContestEntryIndex",
        args: [jobId, agentId, wallet],
      }),
    );
    return indexPlusOne === 0n ? null : Number(indexPlusOne - 1n);
  }

  /** Open bounties with their full metadata in two RPC calls (ids, then one batched read). */
  async listOpenBounties(opts: { category?: string; offset?: bigint; limit?: bigint } = {}): Promise<NadBountyMeta[]> {
    const ids = await this.getOpenBounties(opts.category ?? "", opts.offset ?? 0n, opts.limit ?? 20n);
    if (ids.length === 0) return [];
    return (await this.batch(
      ids.map((id) => this.adapterCall("getBountyMeta", [id])),
      "listOpenBounties",
    )) as NadBountyMeta[];
  }

  async usdcBalance(address?: Address): Promise<bigint> {
    const who = this.requireAddress(address, "usdcBalance");
    return this.rpc("usdcBalance", () =>
      this.publicClient.readContract({
        address: this.network.usdc,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [who],
      }),
    );
  }
  /** Native MON balance in wei (18 decimals). Gas is billed on the gas limit, so keep a margin. */
  async monBalance(address?: Address): Promise<bigint> {
    const who = this.requireAddress(address, "monBalance");
    return this.rpc("monBalance", () => this.publicClient.getBalance({ address: who }));
  }

  // ─── ReputationMirror (Base and Arc paid-job snapshots read by the gates) ──

  private async mirror(): Promise<Address> {
    if (this.mirrorAddress) return this.mirrorAddress;
    this.mirrorAddress =
      this.canonical && this.network.reputationMirror
        ? this.network.reputationMirror
        : await this.rpc("reputationMirror", () =>
            this.publicClient.readContract({
              address: this.bountyAdapter,
              abi: BOUNTY_ADAPTER_V48_ABI,
              functionName: "reputationMirror",
            }),
          );
    return this.mirrorAddress;
  }
  /** Mirrored Base + Arc paid jobs and score sum of an identity owner (sums, never averages). */
  async getMirrorTotals(identityOwner: Address): Promise<NadReputationTotals> {
    if (!isAddress(identityOwner) || isZeroAddress(identityOwner))
      throw new Error("getMirrorTotals: pass the identity owner's address");
    const address = await this.mirror();
    const [paidJobs, scoreSum] = await this.rpc("getMirrorTotals", () =>
      this.publicClient.readContract({
        address,
        abi: REPUTATION_MIRROR_ABI,
        functionName: "getTotals",
        args: [identityOwner],
      }),
    );
    return { paidJobs, scoreSum };
  }
  /** The raw per-source-chain snapshots behind the totals, with the source block they were read at. */
  async getMirrorRecords(identityOwner: Address): Promise<{ base: NadMirrorRecord; arc: NadMirrorRecord }> {
    if (!isAddress(identityOwner) || isZeroAddress(identityOwner))
      throw new Error("getMirrorRecords: pass the identity owner's address");
    const address = await this.mirror();
    const calls = [MIRROR_SOURCE_CHAINS.base, MIRROR_SOURCE_CHAINS.arc].map((sourceChain) => ({
      address,
      abi: REPUTATION_MIRROR_ABI as unknown as Abi,
      functionName: "records",
      args: [identityOwner, sourceChain],
    }));
    const [base, arc] = (await this.batch(calls, "getMirrorRecords")) as [readonly bigint[], readonly bigint[]];
    const record = ([paidJobs, scoreSum, sourceBlock, updatedAt]: readonly bigint[]): NadMirrorRecord => ({
      paidJobs: paidJobs!,
      scoreSum: scoreSum!,
      sourceBlock: sourceBlock!,
      updatedAt: updatedAt!,
    });
    return { base: record(base!), arc: record(arc!) };
  }

  // ─── Descriptions and pinning ──────────────────────────────────────────────

  /**
   * Pin text to IPFS and return its `ipfs://` URI. Uses your own Pinata key
   * (PINATA_JWT, or PINATA_API_KEY + PINATA_SECRET) when set, else the site's
   * pin route for this network (nadbounty.app on mainnet), signed by this wallet.
   */
  async pin(content: string, options: PinViaSiteOptions = {}): Promise<string> {
    return pinTextAuto(content, this.signer ?? { address: this.address }, { network: this.networkName, ...options });
  }
  /** Build the description document, pin it and return the `ipfs://` URI for `createBounty`'s `ipfsDescHash`. */
  async pinDescription(input: CreateDescriptionInput, options: PinViaSiteOptions = {}): Promise<string> {
    return this.pin(serializeDescription(createDescription(input)), options);
  }
  /** Fetch and parse a bounty's description from IPFS. */
  async getBountyDescription(jobId: bigint): Promise<ParsedNadDescription> {
    const meta = await this.getBounty(jobId);
    return parseNadDescription(await fetchIpfsText(meta.ipfsDescHash));
  }
  /**
   * Encrypt `plaintext` to the poster's key found in the contest's description and
   * pin only the sealed envelope. Returns the `ipfs://` URI to pass to `enterContest`.
   */
  async pinContestEntry(jobId: bigint, plaintext: string, options: PinViaSiteOptions = {}): Promise<string> {
    const description = await this.getBountyDescription(jobId);
    return pinEncryptedEntry(plaintext, description, this.signer ?? { address: this.address }, {
      network: this.networkName,
      ...options,
    });
  }

  // ─── Pending actions ───────────────────────────────────────────────────────

  private async escrow(): Promise<Address> {
    if (this.escrowAddress) return this.escrowAddress;
    this.escrowAddress =
      this.canonical && this.network.agenticCommerce
        ? this.network.agenticCommerce
        : await this.rpc("agenticCommerce", () =>
            this.publicClient.readContract({
              address: this.bountyAdapter,
              abi: BOUNTY_ADAPTER_V48_ABI,
              functionName: "agenticCommerce",
            }),
          );
    return this.escrowAddress;
  }

  /**
   * What can be done right now on the jobs an address (and/or an identity) touches:
   * settlements anyone may trigger ("claim") and decisions that have a deadline
   * ("respond"). Read-only; no log queries (the public RPC caps those at 100
   * blocks). Cost is a handful of Multicall3 requests regardless of how many jobs
   * are scanned: one for the job lists, one for their metadata, one for contest
   * and escrow state, and one for contest challenges when any exist.
   *
   * Each entry is `{ jobId, role, action, kind, reason, expiresAt? }`, where
   * `action` is the `NadBountyAgent` method to call with the jobId.
   *
   * @param opts.address a wallet: its posted bounties and everything it took or entered. Defaults to this client.
   * @param opts.agentId also include every job taken or entered by this identity, from any of its wallets.
   * @param opts.maxJobs scan only the newest N job ids of each list (default 200); raise it for very busy accounts.
   * @param opts.now unix seconds to evaluate at; defaults to the latest block time.
   */
  async getPendingActions(
    opts: { address?: Address; agentId?: bigint; maxJobs?: number; now?: bigint } = {},
  ): Promise<NadPendingAction[]> {
    const agentId = opts.agentId ?? 0n;
    const address = opts.address ?? (isZeroAddress(this.address) ? undefined : this.address);
    if (agentId < 0n) throw new RangeError("getPendingActions: agentId must be nonnegative");
    if (!address && agentId === 0n) {
      throw new Error(
        "getPendingActions: pass an address and/or an agentId (a client without a private key has no default address)",
      );
    }
    if (address && (!isAddress(address) || isZeroAddress(address)))
      throw new Error("getPendingActions: not a valid address");
    const maxJobs = opts.maxJobs ?? 200;
    if (!Number.isInteger(maxJobs) || maxJobs < 1)
      throw new Error("getPendingActions: maxJobs must be a positive integer");

    // Stage 0: which jobs, and what time is it.
    const listCalls: BatchCall[] = [];
    if (address)
      listCalls.push(
        this.adapterCall("getMyPostedBounties", [address]),
        this.adapterCall("getMyAssignedBounties", [address]),
      );
    if (agentId !== 0n) listCalls.push(this.adapterCall("getAgentBounties", [agentId]));
    const [lists, now] = await Promise.all([
      this.batch(listCalls, "getPendingActions") as Promise<(readonly bigint[])[]>,
      opts.now !== undefined
        ? Promise.resolve(opts.now)
        : this.rpc("getPendingActions", () => this.publicClient.getBlock()).then((block) => block.timestamp),
    ]);
    const ids = new Map<string, bigint>();
    for (const list of lists) {
      for (const id of list.slice(-maxJobs)) ids.set(id.toString(), id);
    }
    if (ids.size === 0) return [];

    // Stage 1: metadata of every candidate.
    const jobIds = [...ids.values()];
    const metas = (await this.batch(
      jobIds.map((id) => this.adapterCall("getBountyMeta", [id])),
      "getPendingActions",
    )) as NadBountyMeta[];
    const open = metas.filter((meta) => !meta.resolved);
    if (open.length === 0) return [];

    // Stage 2: contest state, entrants, challengers and escrow expiry, in one batch.
    const escrowAddress = open.some((meta) => now > meta.deadline + AC_EXPIRY_BUFFER) ? await this.escrow() : undefined;
    type Plan = { meta: NadBountyMeta; state?: number; challengers?: number; entries?: number; escrow?: number };
    const plans: Plan[] = [];
    const calls: BatchCall[] = [];
    const push = (call: BatchCall) => calls.push(call) - 1;
    for (const meta of open) {
      const plan: Plan = { meta };
      if (meta.contest) {
        plan.state = push(this.adapterCall("getContestState", [meta.jobId]));
        if (meta.rejectedAt !== 0n) plan.challengers = push(this.adapterCall("getContestChallengers", [meta.jobId]));
        const onlyPoster =
          address !== undefined && agentId === 0n && meta.poster.toLowerCase() === address.toLowerCase();
        if (!onlyPoster) plan.entries = push(this.adapterCall("getContestEntries", [meta.jobId]));
      }
      if (escrowAddress && now > meta.deadline + AC_EXPIRY_BUFFER) {
        plan.escrow = push({
          address: escrowAddress,
          abi: ESCROW_ABI as unknown as Abi,
          functionName: "getJob",
          args: [meta.jobId],
        });
      }
      plans.push(plan);
    }
    const results = await this.batch(calls, "getPendingActions");

    // Stage 3: the individual challenges of contests whose rejection was challenged.
    const challengeCalls: BatchCall[] = [];
    const challengeSlots: { plan: Plan; index: number }[] = [];
    for (const plan of plans) {
      if (plan.challengers === undefined) continue;
      for (const index of results[plan.challengers] as readonly number[]) {
        challengeCalls.push(this.adapterCall("getContestChallenge", [plan.meta.jobId, index]));
        challengeSlots.push({ plan, index });
      }
    }
    const challengeResults = challengeCalls.length
      ? ((await this.batch(challengeCalls, "getPendingActions")) as { challengedAt: bigint; respondedAt: bigint }[])
      : [];

    const jobs: NadPendingJob[] = plans.map((plan) => {
      const meta = plan.meta as unknown as NadPendingMeta;
      const job: NadPendingJob = { meta, escrowExpired: false };
      if (plan.escrow !== undefined) {
        job.escrowExpired = (results[plan.escrow] as { status: number }).status === ESCROW_EXPIRED;
      }
      if (plan.state !== undefined) {
        const state = results[plan.state] as readonly [bigint, bigint, bigint, boolean];
        job.contest = {
          entryCount: Number(state[0]),
          closedAt: state[1],
          challenges: challengeSlots
            .map((slot, i) => ({ slot, result: challengeResults[i]! }))
            .filter(({ slot }) => slot.plan === plan)
            .map(({ slot, result }) => ({
              index: slot.index,
              challengedAt: result.challengedAt,
              respondedAt: result.respondedAt,
            })),
          ...(plan.entries !== undefined
            ? { entries: results[plan.entries] as readonly { agentId: bigint; entrant: Address }[] }
            : {}),
        };
      }
      return job;
    });
    return computePendingActions(jobs, { ...(address ? { address } : {}), agentId }, now);
  }
}
