import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

    return metas.filter(m => {
      if (agentOnly && !m.agentOnly) return false;
      if (maxReward !== undefined && m.reward > this._parseUsdc(maxReward)) return false;
      if (minReward !== undefined && m.reward < this._parseUsdc(minReward)) return false;
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
   * Atomically reserve a bounty. On-chain — no race conditions.
   * Uses registered agentId if agent is registered, otherwise takes as human (agentId=0).
   */
  async takeBounty(jobId: bigint): Promise<TxResult> {
    const agentId = this._agentId ?? 0n;

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
