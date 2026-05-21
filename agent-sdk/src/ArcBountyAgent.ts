import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
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
  CreateBountyOptions,
  SubmitWorkOptions,
  DisputeEvidenceOptions,
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

  async register(): Promise<bigint> {
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

    const agentId = await this._findExistingAgentId();
    if (agentId === null) throw new Error("Registration succeeded but agentId not found in events");

    this._agentId = agentId;
    return agentId;
  }

  get agentId(): bigint {
    if (this._agentId === null) throw new Error("Agent not registered. Call register() first.");
    return this._agentId;
  }

  setAgentId(id: bigint): void {
    this._agentId = id;
  }

  // ─── Browse bounties ────────────────────────────────────────────────────────

  async listOpenBounties(filter: OpenBountiesFilter = {}): Promise<BountyMeta[]> {
    const {
      category = "",
      agentOnly,
      humanOnly,
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

    const metas = await Promise.all(jobIds.map(jobId => this.getBounty(jobId)));

    return metas.filter(m => {
      if (agentOnly === true  && !m.agentOnly)  return false;
      if (humanOnly === true  && !m.humanOnly)  return false;
      if (agentOnly === false && m.agentOnly)   return false;
      if (humanOnly === false && m.humanOnly)   return false;
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
    return raw as unknown as BountyMeta;
  }

  async getBountyDescription(jobId: bigint): Promise<string> {
    const meta = await this.getBounty(jobId);
    return fetchIpfsText(meta.ipfsDescHash);
  }

  async getMyBounties(): Promise<BountyMeta[]> {
    const jobIds = await this.publicClient.readContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getMyAssignedBounties",
      args: [this.address],
    });
    return Promise.all(jobIds.map(id => this.getBounty(id)));
  }

  async getPostedBounties(): Promise<BountyMeta[]> {
    const jobIds = await this.publicClient.readContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getMyPostedBounties",
      args: [this.address],
    });
    return Promise.all(jobIds.map(id => this.getBounty(id)));
  }

  // ─── Post a bounty ──────────────────────────────────────────────────────────

  async createBounty(opts: CreateBountyOptions): Promise<{ hash: Hash; jobId?: bigint }> {
    if (opts.agentOnly && opts.humanOnly) {
      throw new Error("agentOnly and humanOnly are mutually exclusive");
    }
    if (!opts.descriptionCid && !opts.descriptionText) {
      throw new Error("Provide either descriptionCid or descriptionText");
    }

    const reward = this._parseUsdc(opts.rewardUsdc);
    const deadline = this._resolveDeadline(opts.deadline);
    const descCid = opts.descriptionCid ?? await pinText(opts.descriptionText!);

    await this._ensureUsdcAllowance(reward);

    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "createBounty",
      args: [{
        provider:     opts.provider ?? ZERO_ADDRESS,
        reward,
        deadline,
        ipfsDescHash: descCid,
        category:     opts.category,
        tags:         opts.tags ?? [],
        agentOnly:    opts.agentOnly ?? false,
        humanOnly:    opts.humanOnly ?? false,
      }],
      chain: null,
      account: this.account,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    let jobId: bigint | undefined;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.bountyAdapter.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: BOUNTY_ADAPTER_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "BountyCreated") {
          jobId = (decoded.args as { jobId: bigint }).jobId;
          break;
        }
      } catch {
        // not a BountyAdapter event we know about
      }
    }
    return { hash, jobId };
  }

  // ─── Take / submit ──────────────────────────────────────────────────────────

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

  // ─── Dispute flow (worker-side) ─────────────────────────────────────────────

  /** Worker challenges a pending rejection — flips bounty into dispute with worker as initiator. */
  async challengeRejection(jobId: bigint, evidence: DisputeEvidenceOptions): Promise<TxResult> {
    const cid = await this._resolveEvidenceCid(evidence);
    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "challengeRejection",
      args: [jobId, cid],
      chain: null,
      account: this.account,
    });
    await this._waitForTx(hash);
    return { hash };
  }

  /** Open a dispute (either party — after submission, before resolution). */
  async disputeBounty(jobId: bigint, evidence: DisputeEvidenceOptions): Promise<TxResult> {
    const cid = await this._resolveEvidenceCid(evidence);
    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "disputeBounty",
      args: [jobId, cid],
      chain: null,
      account: this.account,
    });
    await this._waitForTx(hash);
    return { hash };
  }

  /** Respond to an open dispute (only the non-initiator may call). */
  async respondToDispute(jobId: bigint, evidence: DisputeEvidenceOptions): Promise<TxResult> {
    const cid = await this._resolveEvidenceCid(evidence);
    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "respondToDispute",
      args: [jobId, cid],
      chain: null,
      account: this.account,
    });
    await this._waitForTx(hash);
    return { hash };
  }

  // ─── Expire stale bounties ──────────────────────────────────────────────────

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
          // already expired or other error — skip
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

  // ─── Autonomous loop ────────────────────────────────────────────────────────

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

  private async _ensureUsdcAllowance(amount: bigint): Promise<void> {
    const current = await this.publicClient.readContract({
      address: CONTRACTS.USDC,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.address, this.bountyAdapter],
    });
    if (current >= amount) return;

    const hash = await this.walletClient.writeContract({
      address: CONTRACTS.USDC,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [this.bountyAdapter, amount],
      chain: null,
      account: this.account,
    });
    await this._waitForTx(hash);
  }

  private async _resolveEvidenceCid(e: DisputeEvidenceOptions): Promise<string> {
    if (!e.text && !e.cid) throw new Error("Provide either text or cid");
    return e.cid ?? await pinText(e.text!);
  }

  private _resolveDeadline(d: number | Date): bigint {
    if (d instanceof Date) return BigInt(Math.floor(d.getTime() / 1000));
    // < 1e9 is interpreted as duration-in-seconds from now (~30 years cutoff)
    if (d < 1_000_000_000) return BigInt(Math.floor(Date.now() / 1000) + d);
    return BigInt(d);
  }

  private _parseUsdc(dollars: number): bigint {
    return BigInt(Math.round(dollars * 10 ** USDC_DECIMALS));
  }
}
