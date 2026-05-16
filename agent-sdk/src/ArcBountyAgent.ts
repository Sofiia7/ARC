import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  keccak256,
  encodeAbiParameters,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import {
  BOUNTY_ADAPTER_ABI,
  IDENTITY_REGISTRY_ABI,
  ERC20_ABI,
} from "./abi.js";
import {
  ARC_TESTNET_RPC,
  ARC_TESTNET_CHAIN_ID,
  CONTRACTS,
  USDC_DECIMALS,
  ZERO_ADDRESS,
} from "./constants.js";
import { pinText, fetchIpfsText } from "./ipfs.js";
import type {
  ArcBountyAgentConfig,
  BountyMeta,
  ReputationScore,
  OpenBountiesFilter,
  SubmitWorkOptions,
  AgentInfo,
  TxResult,
  SubscribeOptions,
  Unsubscribe,
} from "./types.js";

const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [ARC_TESTNET_RPC] } },
});

export class ArcBountyAgent {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly bountyAdapter: Address;
  private readonly metadataURI: string;
  private readonly chain: ReturnType<typeof defineChain>;

  // Cached after register()
  private _agentId: bigint | null = null;

  constructor(config: ArcBountyAgentConfig) {
    const rpcUrl = config.rpcUrl ?? ARC_TESTNET_RPC;
    this.chain = defineChain({ ...arcTestnet, rpcUrls: { default: { http: [rpcUrl] } } });

    this.account = privateKeyToAccount(config.privateKey);
    this.metadataURI = config.metadataURI ?? "";
    this.bountyAdapter = config.bountyAdapterAddress ??
      (process.env["BOUNTY_ADAPTER_ADDRESS"] as Address | undefined) ??
      ZERO_ADDRESS;

    this.publicClient = createPublicClient({ chain: this.chain, transport: http(rpcUrl) }) as PublicClient;
    this.walletClient = createWalletClient({ account: this.account, chain: this.chain, transport: http(rpcUrl) });
  }

  get address(): Address {
    return this.account.address;
  }

  // ─── Identity ───────────────────────────────────────────────────────────────

  /**
   * Register this agent in the ERC-8004 IdentityRegistry.
   * Call once at agent startup — saves agentId locally.
   * If already registered, discovers the existing agentId from Transfer events.
   */
  async register(): Promise<bigint> {
    // Check if already registered by scanning Transfer events
    const existing = await this._findExistingAgentId();
    if (existing !== null) {
      this._agentId = existing;
      return existing;
    }

    const hash = await this.walletClient.writeContract({
      address: CONTRACTS.IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "register",
      args: [this.metadataURI],
      chain: null,
      account: this.account,
    });

    await this._waitForTx(hash);

    // Discover agentId from Transfer event (minted to this.address)
    const agentId = await this._findExistingAgentId();
    if (agentId === null) throw new Error("Registration succeeded but agentId not found in events");

    this._agentId = agentId;
    return agentId;
  }

  /** Returns cached agentId. Must call register() first. */
  get agentId(): bigint {
    if (this._agentId === null) throw new Error("Agent not registered. Call register() first.");
    return this._agentId;
  }

  /** Set agentId manually (if already registered in a previous session). */
  setAgentId(id: bigint): void {
    this._agentId = id;
  }

  // ─── Browse bounties ────────────────────────────────────────────────────────

  async listOpenBounties(filter: OpenBountiesFilter = {}): Promise<BountyMeta[]> {
    const {
      category = "",
      agentOnly,
      maxReward,
      minReward,
      offset = 0,
      limit = 50,
    } = filter;

    const jobIds = await this.publicClient.readContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getOpenBounties",
      args: [category, BigInt(offset), BigInt(limit)],
    });

    const metas = await Promise.all(
      jobIds.map(jobId => this.getBounty(jobId))
    );

    const me = this.address.toLowerCase();
    return metas.filter(m => {
      if (agentOnly && !m.agentOnly) return false;
      if (maxReward !== undefined && m.reward > this._parseUsdc(maxReward)) return false;
      if (minReward !== undefined && m.reward < this._parseUsdc(minReward)) return false;
      if (filter.excludeUntakeable) {
        const ZERO = "0x0000000000000000000000000000000000000000";
        if (m.whitelistedProvider !== ZERO && m.whitelistedProvider.toLowerCase() !== me) return false;
      }
      return true;
    });
  }

  async getBounty(jobId: bigint): Promise<BountyMeta> {
    const raw = await this.publicClient.readContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getBountyMeta",
      args: [jobId],
    });
    return raw as BountyMeta;
  }

  /** Fetch full description text from IPFS for a bounty. */
  async getBountyDescription(jobId: bigint): Promise<string> {
    const meta = await this.getBounty(jobId);
    return fetchIpfsText(meta.ipfsDescHash);
  }

  /** Get all bounties currently assigned to this agent's address. */
  async getMyBounties(): Promise<BountyMeta[]> {
    const jobIds = await this.publicClient.readContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getMyAssignedBounties",
      args: [this.address],
    });
    return Promise.all(jobIds.map(id => this.getBounty(id)));
  }

  // ─── Take a bounty ──────────────────────────────────────────────────────────

  /**
   * Smart take: directly calls `takeBounty` for open bounties, or runs the full
   * `commitAndReveal` flow if the bounty has MEV protection enabled.
   * Uses registered agentId if any, otherwise takes as human (agentId=0).
   */
  async takeBounty(jobId: bigint): Promise<TxResult> {
    const agentId = this._agentId ?? 0n;
    const meta = await this.getBounty(jobId);

    if (meta.commitRevealRequired) {
      return this.commitAndReveal(jobId, agentId);
    }

    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "takeBounty",
      args: [jobId, agentId],
      chain: null,
      account: this.account,
    });

    await this._waitForTx(hash);
    return { hash };
  }

  // ─── MEV-resistant take (commit-reveal) ─────────────────────────────────────

  /**
   * Step 1: post a commitment. Salt is generated fresh; remember it and pass to revealTake.
   * Returns `{ hash, salt }` so callers can persist the salt between processes if needed.
   */
  async commitTake(jobId: bigint, agentId: bigint = this._agentId ?? 0n):
    Promise<TxResult & { salt: Hex; commitBlock: bigint }>
  {
    const salt = toHex(randomBytes(32));
    const commitment = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
        [jobId, this.address, agentId, salt],
      ),
    );

    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "commitTake",
      args: [jobId, commitment],
      chain: null,
      account: this.account,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return { hash, salt, commitBlock: receipt.blockNumber };
  }

  /** Step 2: reveal — must be ≥ 2 blocks after commit. */
  async revealTake(jobId: bigint, agentId: bigint, salt: Hex): Promise<TxResult> {
    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "revealTake",
      args: [jobId, agentId, salt],
      chain: null,
      account: this.account,
    });
    await this._waitForTx(hash);
    return { hash };
  }

  /**
   * One-shot commit-reveal: commit, wait until block.number advances by ≥ 2,
   * then reveal. Use this when you don't need to persist salt between sessions.
   */
  async commitAndReveal(jobId: bigint, agentId: bigint = this._agentId ?? 0n): Promise<TxResult> {
    const { salt, commitBlock } = await this.commitTake(jobId, agentId);
    await this._waitUntilBlock(commitBlock + 2n);
    return this.revealTake(jobId, agentId, salt);
  }

  // ─── Subscribe ──────────────────────────────────────────────────────────────

  /**
   * Watch for new bounties via the `BountyCreated` event.
   * Returns an unsubscribe function. Uses viem's watchContractEvent under the hood.
   * Filters off-chain by category to keep the SDK chain-agnostic about indexing.
   */
  subscribeToNewBounties(
    handler: (jobId: bigint, meta: BountyMeta) => void | Promise<void>,
    options: SubscribeOptions = {},
  ): Unsubscribe {
    const { category, pollMs = 12_000 } = options;
    const unwatch = this.publicClient.watchContractEvent({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      eventName: "BountyCreated",
      pollingInterval: pollMs,
      onLogs: async (logs) => {
        for (const log of logs) {
          const jobId = (log.args as { jobId?: bigint }).jobId;
          if (jobId === undefined) continue;
          try {
            const meta = await this.getBounty(jobId);
            if (category && meta.category !== category) continue;
            await handler(jobId, meta);
          } catch {
            // swallow per-event errors so one bad bounty doesn't kill the loop
          }
        }
      },
    });
    return () => unwatch();
  }

  // ─── Dispute & auto-approve ─────────────────────────────────────────────────

  async disputeBounty(jobId: bigint): Promise<TxResult> {
    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "disputeBounty",
      args: [jobId],
      chain: null,
      account: this.account,
    });
    await this._waitForTx(hash);
    return { hash };
  }

  /** Provider-only: force payout after the 48h dispute window elapses. */
  async autoApprove(jobId: bigint): Promise<TxResult> {
    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "autoApprove",
      args: [jobId],
      chain: null,
      account: this.account,
    });
    await this._waitForTx(hash);
    return { hash };
  }

  // ─── Submit work ────────────────────────────────────────────────────────────

  /**
   * Upload result to IPFS and submit on-chain.
   * Provide either `text` (will be pinned) or a pre-computed `cid`.
   */
  async submitWork(jobId: bigint, options: SubmitWorkOptions): Promise<TxResult> {
    if (!options.text && !options.cid) {
      throw new Error("Provide either text or cid");
    }

    const cid = options.cid ?? await pinText(options.text!);

    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "submitWork",
      args: [jobId, cid],
      chain: null,
      account: this.account,
    });

    await this._waitForTx(hash);
    return { hash };
  }

  // ─── Expire stale bounties ──────────────────────────────────────────────────

  /**
   * Scan all open bounties and expire any that have passed their deadline.
   * Permissionless — anyone can call. Useful as a background maintenance task.
   * Returns list of expired jobIds.
   */
  async expireStale(category = "", limit = 100): Promise<bigint[]> {
    const jobIds = await this.publicClient.readContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getOpenBounties",
      args: [category, 0n, BigInt(limit)],
    });

    const now = BigInt(Math.floor(Date.now() / 1000));
    const expired: bigint[] = [];

    for (const jobId of jobIds) {
      const meta = await this.getBounty(jobId);
      if (meta.deadline < now) {
        try {
          const hash = await this.walletClient.writeContract({
            address: this.bountyAdapter,
            abi: BOUNTY_ADAPTER_ABI,
            functionName: "expireBounty",
            args: [jobId],
            chain: null,
            account: this.account,
          });
          await this._waitForTx(hash);
          expired.push(jobId);
        } catch {
          // Already expired or other error — skip
        }
      }
    }

    return expired;
  }

  // ─── Reputation ─────────────────────────────────────────────────────────────

  async getReputation(agentId?: bigint): Promise<ReputationScore> {
    const id = agentId ?? this.agentId;
    const raw = await this.publicClient.readContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getAgentReputation",
      args: [id],
    });
    return raw as ReputationScore;
  }

  async getAgentInfo(): Promise<AgentInfo> {
    const id = this.agentId;
    const reputation = await this.getReputation(id);
    return {
      agentId: id,
      address: this.address,
      metadataURI: this.metadataURI,
      reputation,
    };
  }

  // ─── USDC helpers ────────────────────────────────────────────────────────────

  async usdcBalance(): Promise<bigint> {
    return this.publicClient.readContract({
      address: CONTRACTS.USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.address],
    });
  }

  formatUsdc(raw: bigint): string {
    return (Number(raw) / 10 ** USDC_DECIMALS).toFixed(2);
  }

  // ─── Convenience: full autonomous loop ──────────────────────────────────────

  /**
   * High-level loop: scan open bounties, pick the first matching one,
   * take it, run your task, submit the result.
   *
   * @param filter   - Filter for which bounties to consider
   * @param runTask  - Your async function that receives description and returns result text
   * @returns The jobId that was completed, or null if no bounties found
   */
  async runOnce(
    filter: OpenBountiesFilter,
    runTask: (description: string, meta: BountyMeta) => Promise<string>
  ): Promise<bigint | null> {
    const bounties = await this.listOpenBounties(filter);
    if (bounties.length === 0) return null;

    const bounty = bounties[0]!;
    console.log(`[ArcBountyAgent] Taking bounty #${bounty.jobId} ($${this.formatUsdc(bounty.reward)} USDC)`);

    await this.takeBounty(bounty.jobId);

    const description = await fetchIpfsText(bounty.ipfsDescHash);
    console.log(`[ArcBountyAgent] Running task for bounty #${bounty.jobId}…`);

    const result = await runTask(description, bounty);
    await this.submitWork(bounty.jobId, { text: result });

    console.log(`[ArcBountyAgent] Work submitted for bounty #${bounty.jobId}. Waiting for approval.`);
    return bounty.jobId;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async _waitForTx(hash: Hash): Promise<void> {
    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  private async _waitUntilBlock(target: bigint): Promise<void> {
    // Arc finalises in <1s; poll every 600ms.
    while (true) {
      const current = await this.publicClient.getBlockNumber();
      if (current >= target) return;
      await new Promise(r => setTimeout(r, 600));
    }
  }

  private async _findExistingAgentId(): Promise<bigint | null> {
    try {
      const logs = await this.publicClient.getLogs({
        address: CONTRACTS.IDENTITY_REGISTRY,
        event: IDENTITY_REGISTRY_ABI[2], // Transfer event
        args: {
          from: ZERO_ADDRESS,
          to: this.address,
        },
        fromBlock: 0n,
      });
      if (logs.length === 0) return null;
      const last = logs[logs.length - 1]!;
      return (last.args as { tokenId: bigint }).tokenId;
    } catch {
      return null;
    }
  }

  private _parseUsdc(dollars: number): bigint {
    return BigInt(Math.round(dollars * 10 ** USDC_DECIMALS));
  }
}
