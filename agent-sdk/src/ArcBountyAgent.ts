import {
  createPublicClient,
  decodeEventLog,
  http,
  defineChain,
  isAddress,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import {
  BOUNTY_ADAPTER_ABI,
  IDENTITY_REGISTRY_ABI,
  ERC20_ABI,
} from "./abi.js";
import { ViemSigner } from "./signers/viemSigner.js";
import { CircleSigner } from "./signers/circleSigner.js";
import type { Signer } from "./signers/types.js";
import {
  ARC_TESTNET_RPC,
  ARC_TESTNET_CHAIN_ID,
  CONTRACTS,
  USDC_DECIMALS,
  ZERO_ADDRESS,
} from "./constants.js";
import { pinText, fetchIpfsText } from "./ipfs.js";
import {
  parseUsdc,
  resolveDeadline,
  matchesBountyFilter,
  agentIdFromReceiptLogs,
  workerBondFor,
  bondCreateDeadlineOk,
  bondTakeWindowOk,
} from "./logic.js";
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
  private readonly signer: Signer;
  private readonly bountyAdapter: Address;
  private readonly metadataURI: string;
  private readonly chain: ReturnType<typeof defineChain>;

  private _agentId: bigint | null = null;

  constructor(config: ArcBountyAgentConfig) {
    const rpcUrl = config.rpcUrl ?? ARC_TESTNET_RPC;
    this.chain = defineChain({ ...arcTestnet, rpcUrls: { default: { http: [rpcUrl] } } });

    this.signer = config.circleWallet
      ? new CircleSigner(config.circleWallet)
      : new ViemSigner(config.privateKey as `0x${string}`, this.chain, rpcUrl);
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
  }

  get address(): Address {
    return this.signer.address;
  }

  // ─── Identity ───────────────────────────────────────────────────────────────

  async register(): Promise<bigint> {
    const existing = await this._findExistingAgentId();
    if (existing !== null) {
      this._agentId = existing;
      return existing;
    }

    const hash = await this.signer.writeContract({
      address: CONTRACTS.IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "register",
      args: [this.metadataURI],
    });

    // Decode the agentId straight from the registration receipt — authoritative
    // and avoids a wide getLogs scan that public RPCs reject on long chains.
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    const agentId = agentIdFromReceiptLogs(receipt.logs, CONTRACTS.IDENTITY_REGISTRY, this.signer.address);
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

    return metas.filter(m => matchesBountyFilter(m, { agentOnly, humanOnly, maxReward, minReward }));
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

    const reward = parseUsdc(opts.rewardUsdc);
    const deadline = resolveDeadline(opts.deadline);
    if (opts.requireWorkerBond) {
      // V4.1 bond-honeypot guard: the contract rejects requireWorkerBond
      // bounties with less than MIN_BOND_BOUNTY_DURATION (24h) to deadline.
      // Fail fast here with a clearer message than the on-chain revert. The
      // safety buffer keeps a deadline that clears the floor only at signing
      // time from reverting on-chain a few seconds later — after the USDC
      // approve (tx 1 of 2) already went through.
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (!bondCreateDeadlineOk(deadline, nowSec)) {
        throw new Error(
          "requireWorkerBond bounties need a deadline at least 24h out (MIN_BOND_BOUNTY_DURATION) " +
          "plus a safety margin — use 25h or more from now",
        );
      }
    }
    const descCid = opts.descriptionCid ?? await pinText(opts.descriptionText!);

    await this._ensureUsdcAllowance(reward);

    const hash = await this.signer.writeContract({
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
        requireWorkerBond: opts.requireWorkerBond ?? false,
      }],
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

  async takeBounty(jobId: bigint, opts: { skipBondTakeWindowGuard?: boolean } = {}): Promise<TxResult> {
    const agentId = this._agentId ?? 0n;
    // V4: a requireWorkerBond bounty pulls the bond from the worker via
    // transferFrom inside takeBounty — without a USDC allowance the take
    // reverts. Read the live bond parameters rather than hardcoding them so
    // the SDK stays correct if a future deployment tunes them.
    const meta = await this.getBounty(jobId);
    if (meta.requireWorkerBond) {
      // V4.2 take-window guard: taking a bond bounty with under 12h to its
      // deadline is a bond-forfeiture trap (no plausible time to deliver).
      // Enforced client-side even against pre-V4.2 deployments, which allow
      // the take on-chain. Pass skipBondTakeWindowGuard to override
      // deliberately (e.g. a task you know takes minutes, not hours).
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (!opts.skipBondTakeWindowGuard && !bondTakeWindowOk(meta.deadline, nowSec)) {
        throw new Error(
          `takeBounty(${jobId}): bond bounty has under 12h to its deadline (MIN_BOND_TAKE_WINDOW) — ` +
          "taking it risks forfeiting your bond. Pass { skipBondTakeWindowGuard: true } to override.",
        );
      }
      const [bondBps, minBond] = await Promise.all([
        this.publicClient.readContract({
          address: this.bountyAdapter, abi: BOUNTY_ADAPTER_ABI, functionName: "WORKER_BOND_BPS",
        }),
        this.publicClient.readContract({
          address: this.bountyAdapter, abi: BOUNTY_ADAPTER_ABI, functionName: "MIN_WORKER_BOND",
        }),
      ]);
      await this._ensureUsdcAllowance(workerBondFor(meta.reward, bondBps, minBond));
    }
    return this._writeAdapter("takeBounty", [jobId, agentId]);
  }

  async submitWork(jobId: bigint, options: SubmitWorkOptions): Promise<TxResult> {
    if (!options.text && !options.cid) {
      throw new Error("Provide either text or cid");
    }
    const cid = options.cid ?? await pinText(options.text!);
    return this._writeAdapter("submitWork", [jobId, cid]);
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

  /**
   * V4.1: withdraw a pending rejection you proposed (poster only), returning
   * the bounty to the pre-rejection state so approveBounty is reachable
   * again. Only valid while the rejection is unchallenged and unresolved.
   */
  async withdrawRejection(jobId: bigint): Promise<TxResult> {
    return this._writeAdapter("withdrawRejection", [jobId]);
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

  /**
   * V3.3 liveness fallback: if the respondent DID reply (so claimDefaultRuling
   * no longer applies) but the arbitrator never called resolveDispute within
   * ARBITRATOR_TIMEOUT (30d) of disputeRaisedAt, anyone may trigger a neutral
   * 50/50 split between poster and worker. No reputation penalty either way.
   */
  async claimArbitratorTimeout(jobId: bigint): Promise<TxResult> {
    return this._writeAdapter("claimArbitratorTimeout", [jobId]);
  }

  // ─── Dispute flow (worker-side) ─────────────────────────────────────────────

  /** Worker challenges a pending rejection — flips bounty into dispute with worker as initiator. */
  async challengeRejection(jobId: bigint, evidence: DisputeEvidenceOptions): Promise<TxResult> {
    const cid = await this._resolveEvidenceCid(evidence);
    return this._writeAdapter("challengeRejection", [jobId, cid]);
  }

  /** Open a dispute (either party — after submission, before resolution). */
  async disputeBounty(jobId: bigint, evidence: DisputeEvidenceOptions): Promise<TxResult> {
    const cid = await this._resolveEvidenceCid(evidence);
    return this._writeAdapter("disputeBounty", [jobId, cid]);
  }

  /** Respond to an open dispute (only the non-initiator may call). */
  async respondToDispute(jobId: bigint, evidence: DisputeEvidenceOptions): Promise<TxResult> {
    const cid = await this._resolveEvidenceCid(evidence);
    return this._writeAdapter("respondToDispute", [jobId, cid]);
  }

  // ─── Expire stale bounties ──────────────────────────────────────────────────

  /**
   * Scans the full bounty set and calls expireBounty() on anything past its
   * deadline with no submission and not yet resolved. Stops after finding
   * `limit` candidates to expire.
   *
   * NOTE: `getOpenBounties` (used pre-V3.3) can NEVER return a candidate for
   * this — it excludes any bounty whose deadline has already passed by
   * definition (`_isOpenMatch` checks `block.timestamp <= deadline`). This
   * scan walks `allJobIds` directly instead, mirroring the keeper cron route
   * (`frontend/app/api/cron/keeper/route.ts`).
   */
  async expireStale(category = "", limit = 100): Promise<bigint[]> {
    const total = await this.publicClient.readContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "totalBounties",
    });

    const now = BigInt(Math.floor(Date.now() / 1000));
    const expired: bigint[] = [];

    for (let i = 0n; i < total && expired.length < limit; i++) {
      const jobId = await this.publicClient.readContract({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_ABI,
        functionName: "allJobIds",
        args: [i],
      });

      const meta = await this.getBounty(jobId);
      if (meta.resolved) continue;
      if (meta.submittedResultHash.length > 0) continue; // has a submission — expireBounty rejects this
      if (category && meta.category !== category) continue;
      if (meta.deadline >= now) continue;

      try {
        await this._writeAdapter("expireBounty", [jobId]);
        expired.push(jobId);
      } catch {
        // already expired/resolved by someone else — skip
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

  /**
   * V4 anti-Sybil signal: count of distinct posters who've actually paid out
   * a completed bounty to this agent. Costs N real funded wallets to fake N —
   * unlike the raw ERC-8004 average score, which one alt account can inflate
   * for a few cents. See V4_DESIGN_ANTI_SYBIL.md.
   */
  async getUniquePosterCount(agentId?: bigint): Promise<bigint> {
    const id = agentId ?? this.agentId;
    return this.publicClient.readContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "uniquePosterCount",
      args: [id],
    });
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
            if (!matchesBountyFilter(meta, filter)) continue;
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

  // ─── Dispute watchdog (self-protection) ─────────────────────────────────────

  /**
   * Background watchdog over this agent's own assigned bounties. An agent
   * that only calls `takeBounty`/`submitWork` and then goes idle is exposed
   * to every counterparty-controlled window in the contract: a poster can
   * reject a correct submission (48h to challenge), open a dispute the agent
   * never responds to (48h to respond, then the *other* side wins by
   * default), or the agent may simply be owed a payout nobody triggered yet
   * (14d autoApprove / 30d claimArbitratorTimeout). `protect()` polls
   * `getMyBounties()` and reacts automatically:
   *
   *  - **Pending rejection, not yet challenged** → calls `onRejection` (if
   *    provided) for evidence and calls `challengeRejection`. Without a
   *    callback, a rejection is only logged, never auto-challenged — silently
   *    auto-disputing every rejection would be its own failure mode.
   *  - **Dispute raised by the other party, not yet responded** → calls
   *    `onDisputeAgainstMe` for evidence and calls `respondToDispute`. Same
   *    caveat: no callback means log-only.
   *  - **Dispute resolved-by-response but arbitrator never ruled (30d)** →
   *    calls `claimArbitratorTimeout` automatically (permissionless, no
   *    evidence needed — this just unsticks the agent's own frozen funds).
   *  - **Submitted, approval window elapsed (14d), poster silent** → calls
   *    `autoApprove` automatically.
   *
   * Returns an `unwatch()` function. Errors on any single bounty are logged
   * and swallowed so one bad case can't kill the whole watchdog.
   */
  protect(options: {
    pollingIntervalMs?: number;
    onRejection?: (meta: BountyMeta) => Promise<DisputeEvidenceOptions>;
    onDisputeAgainstMe?: (meta: BountyMeta) => Promise<DisputeEvidenceOptions>;
    onEvent?: (event: string, meta: BountyMeta) => void;
  } = {}): () => void {
    const pollingIntervalMs = options.pollingIntervalMs ?? 60_000;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        await this._protectOnce(options);
      } catch (err) {
        console.error("[ArcBountyAgent.protect] tick error:", err);
      }
      if (!stopped) timer = setTimeout(tick, pollingIntervalMs);
    };

    let timer: ReturnType<typeof setTimeout> = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  private async _protectOnce(options: {
    onRejection?: (meta: BountyMeta) => Promise<DisputeEvidenceOptions>;
    onDisputeAgainstMe?: (meta: BountyMeta) => Promise<DisputeEvidenceOptions>;
    onEvent?: (event: string, meta: BountyMeta) => void;
  }): Promise<void> {
    const [rejectionWindow, disputeWindow, approvalTimeout, arbitratorTimeout] = await Promise.all([
      this.publicClient.readContract({
        address: this.bountyAdapter, abi: BOUNTY_ADAPTER_ABI, functionName: "REJECTION_CHALLENGE_WINDOW",
      }),
      this.publicClient.readContract({
        address: this.bountyAdapter, abi: BOUNTY_ADAPTER_ABI, functionName: "DISPUTE_RESPONSE_WINDOW",
      }),
      this.publicClient.readContract({
        address: this.bountyAdapter, abi: BOUNTY_ADAPTER_ABI, functionName: "APPROVAL_TIMEOUT",
      }),
      this.publicClient.readContract({
        address: this.bountyAdapter, abi: BOUNTY_ADAPTER_ABI, functionName: "ARBITRATOR_TIMEOUT",
      }),
    ]);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const mine = await this.getMyBounties();

    for (const meta of mine) {
      if (meta.resolved) continue;

      try {
        // 1. Pending rejection, still within the challenge window, not yet challenged.
        if (meta.rejectedAt > 0n && !meta.inDispute && now <= meta.rejectedAt + rejectionWindow) {
          options.onEvent?.("rejection_pending", meta);
          if (options.onRejection) {
            const evidence = await options.onRejection(meta);
            await this.challengeRejection(meta.jobId, evidence);
            options.onEvent?.("rejection_challenged", meta);
          }
          continue;
        }

        // 2. Dispute open, raised by the OTHER party, this agent hasn't responded.
        if (
          meta.inDispute
          && meta.disputeResponseHash.length === 0
          && meta.disputeInitiator.toLowerCase() !== this.address.toLowerCase()
          && now <= meta.disputeRaisedAt + disputeWindow
        ) {
          options.onEvent?.("dispute_needs_response", meta);
          if (options.onDisputeAgainstMe) {
            const evidence = await options.onDisputeAgainstMe(meta);
            await this.respondToDispute(meta.jobId, evidence);
            options.onEvent?.("dispute_responded", meta);
          }
          continue;
        }

        // 3. Dispute answered on both sides but the arbitrator ghosted (V3.3).
        if (
          meta.inDispute
          && meta.disputeResponseHash.length > 0
          && now > meta.disputeRaisedAt + arbitratorTimeout
        ) {
          await this.claimArbitratorTimeout(meta.jobId);
          options.onEvent?.("arbitrator_timeout_claimed", meta);
          continue;
        }

        // 4. Submitted, poster silent past the approval window.
        if (
          meta.submittedAt > 0n
          && meta.rejectedAt === 0n
          && !meta.inDispute
          && now > meta.submittedAt + approvalTimeout
        ) {
          await this.autoApprove(meta.jobId);
          options.onEvent?.("auto_approved", meta);
        }
      } catch (err) {
        console.error(`[ArcBountyAgent.protect] error handling bounty #${meta.jobId}:`, err);
      }
    }
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
    const hash = await this.signer.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName,
      args,
    });
    await this._waitForTx(hash);
    return { hash };
  }

  /**
   * Best-effort idempotency check: scan a bounded recent window for a
   * Transfer(0x0 → self) on the registry. Arc's public RPC caps eth_getLogs to
   * a 10,000-block range per call (confirmed empirically — a single wider
   * request errors outright), so we page backward in 10k chunks up to a total
   * lookback ceiling instead of issuing one oversized request. A chunk/network
   * error aborts the whole scan and falls back to "register again", which is
   * acceptable — worst case we mint a redundant identity, not lose data.
   */
  private async _findExistingAgentId(): Promise<bigint | null> {
    const CHUNK = 10_000n; // Arc RPC's actual eth_getLogs range cap.
    const TOTAL_LOOKBACK = 500_000n;
    try {
      const head = await this.publicClient.getBlockNumber();
      const floor = head > TOTAL_LOOKBACK ? head - TOTAL_LOOKBACK : 0n;

      for (let to = head; to > floor; to -= CHUNK) {
        const from = to - CHUNK + 1n > floor ? to - CHUNK + 1n : floor;
        const logs = await this.publicClient.getLogs({
          address: CONTRACTS.IDENTITY_REGISTRY,
          event: IDENTITY_REGISTRY_ABI[2], // Transfer event
          args: { from: ZERO_ADDRESS, to: this.address },
          fromBlock: from,
          toBlock: to,
        });
        if (logs.length > 0) {
          const last = logs[logs.length - 1]!;
          return (last.args as { tokenId: bigint }).tokenId;
        }
        if (from === floor) break;
      }
      return null;
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

    const hash = await this.signer.writeContract({
      address: CONTRACTS.USDC,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [this.bountyAdapter, amount],
    });
    await this._waitForTx(hash);
  }

  private async _resolveEvidenceCid(e: DisputeEvidenceOptions): Promise<string> {
    if (!e.text && !e.cid) throw new Error("Provide either text or cid");
    return e.cid ?? await pinText(e.text!);
  }
}
