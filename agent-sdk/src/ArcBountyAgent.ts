import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  defineChain,
  isAddress,
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
    const rawAdapter = config.bountyAdapterAddress ??
      (process.env["BOUNTY_ADAPTER_ADDRESS"] as Address | undefined);
    if (!rawAdapter) {
      throw new Error(
        "ArcBountyAgent: bountyAdapterAddress is required (constructor option or BOUNTY_ADAPTER_ADDRESS env). " +
        "See agent-sdk/.env.example. Source of truth: contracts/DEPLOYMENTS.md.",
      );
    }
    if (!isAddress(rawAdapter) || rawAdapter.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new Error(`ArcBountyAgent: invalid bountyAdapterAddress: ${rawAdapter}`);
    }
    this.bountyAdapter = rawAdapter as Address;

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

    // Decode the agentId straight from the registration receipt — authoritative
    // and avoids a wide getLogs scan that public RPCs reject on long chains.
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    const agentId = this._agentIdFromReceiptLogs(receipt.logs);
    if (agentId === null) throw new Error("Registration succeeded but agentId not found in events");

    this._agentId = agentId;
    return agentId;
  }

  /** Pull the minted tokenId from a Transfer(from=0x0, to=self) log in a receipt. */
  private _agentIdFromReceiptLogs(logs: readonly { address: string; topics: readonly string[] }[]): bigint | null {
    const TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const me = this.account.address.toLowerCase().slice(2).padStart(64, "0");
    for (const log of logs) {
      if (log.address.toLowerCase() !== CONTRACTS.IDENTITY_REGISTRY.toLowerCase()) continue;
      if (log.topics.length < 4) continue;
      if (log.topics[0]?.toLowerCase() !== TRANSFER_SIG) continue;
      if (log.topics[1]?.toLowerCase() !== "0x" + "0".repeat(64)) continue; // from == 0x0
      if (log.topics[2]?.toLowerCase() !== "0x" + me) continue; // to == self
      return BigInt(log.topics[3]!); // tokenId
    }
    return null;
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

  // ─── Poster cycle ───────────────────────────────────────────────────────────
  // These let a protocol/DAO agent run the full poster side end-to-end.

  /** Approve a submission and pay the worker. Records on-chain reputation. */
  async approveBounty(jobId: bigint, reputationScore = 95): Promise<TxResult> {
    return this._writeAdapter("approveBounty", [jobId, reputationScore]);
  }

  /**
   * Permissionless payout after APPROVAL_TIMEOUT (14d) from submission.
   * Use this from a watchdog agent to unstick ghosted posters.
   */
  async autoApprove(jobId: bigint): Promise<TxResult> {
    return this._writeAdapter("autoApprove", [jobId]);
  }

  /** Propose rejection. Triggers a 48h challenge window for the worker. */
  async rejectBounty(jobId: bigint, evidence: DisputeEvidenceOptions): Promise<TxResult> {
    const cid = await this._resolveEvidenceCid(evidence);
    return this._writeAdapter("rejectBounty", [jobId, cid]);
  }

  /** After the challenge window expires unchallenged, anyone may finalize. */
  async finalizeRejection(jobId: bigint): Promise<TxResult> {
    return this._writeAdapter("finalizeRejection", [jobId]);
  }

  /** Cancel a bounty (only valid before takeBounty). Full USDC refund. */
  async cancelBounty(jobId: bigint): Promise<TxResult> {
    return this._writeAdapter("cancelBounty", [jobId]);
  }

  /** Permissionless expiry after deadline. Refunds poster if no submission. */
  async expireBounty(jobId: bigint): Promise<TxResult> {
    return this._writeAdapter("expireBounty", [jobId]);
  }

  /** Arbitrator-only ruling. `payProvider` true → worker wins, false → refund. */
  async resolveDispute(
    jobId: bigint,
    payProvider: boolean,
    ruling: DisputeEvidenceOptions,
    reputationPenalty = 0,
  ): Promise<TxResult> {
    const cid = await this._resolveEvidenceCid(ruling);
    return this._writeAdapter("resolveDispute", [jobId, payProvider, cid, reputationPenalty]);
  }

  /** After 48h with no response, anyone may claim the default ruling. */
  async claimDefaultRuling(jobId: bigint): Promise<TxResult> {
    return this._writeAdapter("claimDefaultRuling", [jobId]);
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
    try {
      const raw = await this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_ABI,
        functionName: "getAgentReputation",
        args: [id],
      });
      return raw as ReputationScore;
    } catch {
      // The live Arc ReputationRegistry reverts for an agent with no feedback
      // yet (freshly registered, zero completed jobs). Treat as a clean slate.
      return { averageScore: 0n, totalFeedbacks: 0n, totalJobs: 0n };
    }
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

  // ─── Event subscriptions ────────────────────────────────────────────────────

  /**
   * Watch `BountyCreated` events and invoke `onMatch` for each new bounty that
   * passes the filter. Returns an `unwatch()` function — call it to stop.
   *
   * Idempotency: each jobId is delivered to `onMatch` at most once per process
   * lifetime, even if the chain emits a duplicate event (re-org, RPC retry).
   * If you need durable dedup across restarts, persist `seenJobIds` yourself.
   */
  subscribeToNewBounties(
    filter: OpenBountiesFilter,
    onMatch: (meta: BountyMeta) => void | Promise<void>,
  ): () => void {
    const seen = new Set<string>();
    const unwatch = this.publicClient.watchContractEvent({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      eventName: "BountyCreated",
      onLogs: async logs => {
        for (const log of logs) {
          const args = (log as { args?: { jobId?: bigint } }).args;
          const jobId = args?.jobId;
          if (jobId === undefined) continue;
          const key = jobId.toString();
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const meta = await this.getBounty(jobId);
            if (!this._matchesFilter(meta, filter)) continue;
            await onMatch(meta);
          } catch (err) {
            // Swallow per-event errors so one bad bounty doesn't kill the loop.
            console.error(`[ArcBountyAgent] onMatch error for #${key}:`, err);
          }
        }
      },
      pollingInterval: 4_000,
    });
    return unwatch;
  }

  private _matchesFilter(m: BountyMeta, f: OpenBountiesFilter): boolean {
    if (f.category && m.category !== f.category) return false;
    if (f.agentOnly === true  && !m.agentOnly)   return false;
    if (f.humanOnly === true  && !m.humanOnly)   return false;
    if (f.agentOnly === false &&  m.agentOnly)   return false;
    if (f.humanOnly === false &&  m.humanOnly)   return false;
    if (f.maxReward !== undefined && m.reward > this._parseUsdc(f.maxReward)) return false;
    if (f.minReward !== undefined && m.reward < this._parseUsdc(f.minReward)) return false;
    return true;
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

  /**
   * Write to BountyAdapter with the canonical (chain, account) tuple. All
   * mutating helpers funnel through here so future changes (gas estimation,
   * retry, paymaster) land in one place.
   */
  private async _writeAdapter(functionName: string, args: readonly unknown[]): Promise<TxResult> {
    const hash = await this.walletClient.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: functionName as never,
      args: args as never,
      chain: null,
      account: this.account,
    });
    await this._waitForTx(hash);
    return { hash };
  }

  /**
   * Best-effort idempotency check: scan a bounded recent window for a
   * Transfer(0x0 → self) on the registry. A `fromBlock: 0` scan is rejected by
   * public RPCs on long chains, so we look back a fixed span and tolerate
   * failure (returning null just means "register again", which is acceptable).
   */
  private async _findExistingAgentId(): Promise<bigint | null> {
    try {
      const head = await this.publicClient.getBlockNumber();
      const LOOKBACK = 500_000n;
      const fromBlock = head > LOOKBACK ? head - LOOKBACK : 0n;
      const logs = await this.publicClient.getLogs({
        address: CONTRACTS.IDENTITY_REGISTRY,
        event: IDENTITY_REGISTRY_ABI[2], // Transfer event
        args: { from: ZERO_ADDRESS, to: this.address },
        fromBlock,
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
