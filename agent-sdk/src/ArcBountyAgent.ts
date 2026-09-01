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
  IDENTITY_TRANSFER_EVENT,
  ERC20_ABI,
} from "./abi.js";
import { ViemSigner } from "./signers/viemSigner.js";
import { CircleSigner } from "./signers/circleSigner.js";
import type { Signer } from "./signers/types.js";
import {
  resolveNetwork,
  USDC_DECIMALS,
  ZERO_ADDRESS,
  type NetworkConfig,
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
  PendingAction,
} from "./types.js";

/**
 * How long to wait for a transaction receipt before giving up on it.
 *
 * Generous next to a 2s Base block or a 1s Arc one: this is not a latency
 * budget, it is the line past which "still mining" stops being the likely
 * explanation. See `_waitForTx`.
 */
const TX_RECEIPT_TIMEOUT_MS = 120_000;

/** Used when `protect()` is called without an `onEvent` callback, so
 * actionable events are never fully silent even with zero configuration. */
function defaultOnEvent(event: string, meta: BountyMeta): void {
  console.warn(`[ArcBountyAgent] ${event} - bounty #${meta.jobId.toString()}`);
}

export class ArcBountyAgent {
  /** Resolved config of the network this agent talks to (chain id, contracts, explorer…). */
  readonly network: NetworkConfig;

  private readonly publicClient: PublicClient;
  private readonly signer: Signer;
  private readonly bountyAdapter: Address;
  private readonly metadataURI: string;
  private readonly chain: ReturnType<typeof defineChain>;

  private _agentId: bigint | null = null;
  /** True once `ownerOf(_agentId)` has confirmed this wallet owns that identity. */
  private _agentIdVerified = false;

  constructor(config: ArcBountyAgentConfig) {
    // Everything network-shaped (chain id, RPC, contract addresses) comes
    // from the RESOLVED network. Explicit config overrides still win - an
    // rpcUrl override changes only the transport URL, never the chain id
    // (pre-0.5 the constructor kept the testnet chain id even when rpcUrl
    // pointed elsewhere).
    const network = resolveNetwork(config.network ?? "arc-testnet");
    this.network = network;
    const rpcUrl = config.rpcUrl ?? network.rpcUrl;
    this.chain = defineChain({
      id: network.chainId,
      name: network.name,
      nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });

    this.signer = config.circleWallet
      ? new CircleSigner(config.circleWallet)
      : new ViemSigner(config.privateKey as `0x${string}`, this.chain, rpcUrl);
    this.metadataURI = config.metadataURI ?? "";
    // Adapter precedence: explicit config > BOUNTY_ADAPTER_ADDRESS env
    // (testnet only - a stale testnet env var must never leak onto mainnet)
    // > the resolved network's canonical adapter (for mainnet that is
    // ARC_MAINNET_BOUNTY_ADAPTER, via resolveNetwork).
    const envAdapter = network.testnet
      ? (process.env["BOUNTY_ADAPTER_ADDRESS"]?.trim() as Address | undefined) || undefined
      : undefined;
    const rawAdapter = config.bountyAdapterAddress ?? envAdapter ?? network.defaultBountyAdapter;
    if (!rawAdapter) {
      throw new Error(
        `ArcBountyAgent: no BountyAdapter address for network "${network.name}" - pass ` +
        "bountyAdapterAddress in the constructor" +
        (network.testnet
          ? " or set BOUNTY_ADAPTER_ADDRESS. See agent-sdk/.env.example. Source of truth: contracts/DEPLOYMENTS.md."
          : " or set ARC_MAINNET_BOUNTY_ADAPTER. Source of truth: contracts/DEPLOYMENTS.md once the mainnet deployment is published."),
      );
    }
    if (!isAddress(rawAdapter) || rawAdapter.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new Error(`ArcBountyAgent: invalid bountyAdapterAddress: ${rawAdapter}`);
    }
    this.bountyAdapter = rawAdapter as Address;

    this.publicClient = createPublicClient({ chain: this.chain, transport: http(rpcUrl) }) as PublicClient;

    // Identity may be pinned up front (config `agentId`, or the AGENT_ID env
    // var). This is the only reliable path on Base: the canonical ERC-8004
    // registry exposes no reverse address → agentId lookup, and every free Base
    // RPC caps eth_getLogs at 10k blocks (~5.5h of a 2s chain), so the
    // Transfer-log scan below can only ever see a sliver of history. A pinned id
    // lets a freshly started process know its own identity with zero RPC calls;
    // resolveAgentId() still verifies it against ownerOf before it is used.
    const rawAgentId = config.agentId ?? process.env["AGENT_ID"]?.trim();
    if (rawAgentId !== undefined && rawAgentId !== "") {
      let parsed: bigint;
      try {
        parsed = BigInt(rawAgentId);
      } catch {
        throw new Error(`ArcBountyAgent: invalid agentId ${JSON.stringify(String(rawAgentId))} - expected a positive integer.`);
      }
      if (parsed <= 0n) {
        throw new Error(`ArcBountyAgent: agentId must be positive, got ${parsed.toString()}. 0 means "no agent" on-chain.`);
      }
      this._agentId = parsed;
    }
  }

  get address(): Address {
    return this.signer.address;
  }

  // ─── Identity ───────────────────────────────────────────────────────────────

  /**
   * @param metadataURI Overrides the constructor's `metadataURI` for this call
   *   only - callers that pin metadata just before registering (the MCP
   *   server's `register_agent` tool does exactly this) need the freshly
   *   pinned CID on-chain, not whatever (often empty) value the agent was
   *   constructed with.
   */
  async register(metadataURI?: string): Promise<bigint> {
    // A pinned id is authoritative: verify and reuse it rather than minting a
    // second identity for a wallet that already has one.
    if (this._agentId !== null) return (await this.resolveAgentId())!;

    const { agentId: existing, scanned } = await this._findExistingAgentId();
    if (existing !== null) {
      this._agentId = existing;
      this._agentIdVerified = true;
      return existing;
    }
    if (!scanned) {
      // The scan errored (RPC failure or rate limit) rather than completing and
      // finding nothing. Minting here would create a SECOND identity and orphan
      // every rating attached to the first - reputation is this protocol's whole
      // point, so refuse instead of silently forking it.
      throw new Error(
        "ArcBountyAgent.register(): could not determine whether this wallet already has an agentId - " +
        "the registry log scan failed (RPC error or rate limit). Registering now risks minting a second " +
        "identity and orphaning the reputation on the first. Retry against a healthy RPC, or pass the " +
        "known id via the `agentId` config option / AGENT_ID env var.",
      );
    }

    const hash = await this.signer.writeContract({
      address: this.network.contracts.IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "register",
      args: [metadataURI ?? this.metadataURI],
    });

    // Decode the agentId straight from the registration receipt - authoritative
    // and avoids a wide getLogs scan that public RPCs reject on long chains.
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    const agentId = agentIdFromReceiptLogs(receipt.logs, this.network.contracts.IDENTITY_REGISTRY, this.signer.address);
    if (agentId === null) throw new Error("Registration succeeded but agentId not found in events");

    this._agentId = agentId;
    this._agentIdVerified = true;
    return agentId;
  }

  /**
   * Synchronous accessor for an ALREADY resolved id. It never touches the
   * chain, so it throws on a freshly constructed agent even when the wallet
   * demonstrably owns an identity - use `resolveAgentId()` for that.
   */
  get agentId(): bigint {
    if (this._agentId === null) {
      throw new Error(
        "Agent identity is not resolved in this process yet. `agentId` is a synchronous getter and never " +
        "reads the chain - call `await agent.resolveAgentId()` (or `register()`, which is idempotent), pass " +
        "`agentId` to the constructor, or set AGENT_ID.",
      );
    }
    return this._agentId;
  }

  setAgentId(id: bigint): void {
    this._agentId = id;
    this._agentIdVerified = false;
  }

  /**
   * Resolve this wallet's ERC-8004 agentId, touching the chain at most once per
   * process. Returns null when the wallet owns no identity.
   *
   * Order of resolution:
   *   1. a pinned id (constructor `agentId` / AGENT_ID), checked against
   *      `ownerOf` - the same check `BountyAdapter.takeBounty` performs, so a
   *      wrong pin fails here with a clear message instead of as a revert;
   *   2. a bounded Transfer(0x0 → self) log scan.
   *
   * Step 2 is best-effort by nature: the registry has no reverse address →
   * agentId lookup and public RPCs cap eth_getLogs at 10k blocks, so on Base it
   * only sees a few hours of history. Pin the id in production.
   */
  async resolveAgentId(): Promise<bigint | null> {
    if (this._agentId !== null) {
      if (!this._agentIdVerified) {
        const owner = await this.publicClient.readContract({
          address: this.network.contracts.IDENTITY_REGISTRY,
          abi: IDENTITY_REGISTRY_ABI,
          functionName: "ownerOf",
          args: [this._agentId],
        });
        if (owner.toLowerCase() !== this.address.toLowerCase()) {
          throw new Error(
            `ArcBountyAgent: agentId ${this._agentId.toString()} is owned by ${owner}, not by this wallet ` +
            `(${this.address}). Correct the pinned id (\`agentId\` config / AGENT_ID) or sign with the owning wallet.`,
          );
        }
        this._agentIdVerified = true;
      }
      return this._agentId;
    }

    const { agentId } = await this._findExistingAgentId();
    if (agentId !== null) {
      this._agentId = agentId;
      this._agentIdVerified = true;
    }
    return agentId;
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
      // time from reverting on-chain a few seconds later - after the USDC
      // approve (tx 1 of 2) already went through.
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (!bondCreateDeadlineOk(deadline, nowSec)) {
        throw new Error(
          "requireWorkerBond bounties need a deadline at least 24h out (MIN_BOND_BOUNTY_DURATION) " +
          "plus a safety margin - use 25h or more from now",
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

  async takeBounty(
    jobId: bigint,
    opts: { skipBondTakeWindowGuard?: boolean; asHuman?: boolean } = {},
  ): Promise<TxResult> {
    // V4: a requireWorkerBond bounty pulls the bond from the worker via
    // transferFrom inside takeBounty - without a USDC allowance the take
    // reverts. Read the live bond parameters rather than hardcoding them so
    // the SDK stays correct if a future deployment tunes them.
    const meta = await this.getBounty(jobId);
    // Resolve from the chain rather than reading the in-memory cache: a fresh
    // process (every MCP server start) had no cached id, sent agentId=0, and
    // every agentOnly bounty reverted with "agent only: provide agentId".
    // `asHuman` keeps the pre-fix escape hatch explicit: a wallet that owns an
    // identity can still take a humanOnly bounty, but only by saying so.
    const agentId = opts.asHuman ? 0n : (await this.resolveAgentId()) ?? 0n;
    if (meta.agentOnly && agentId === 0n) {
      throw new Error(
        `takeBounty(${jobId.toString()}): this bounty is agentOnly, but no ERC-8004 identity resolved for ` +
        `${this.address} on ${this.network.name}. Call register() first, or pin a known id via the ` +
        "`agentId` config option / AGENT_ID env var.",
      );
    }
    if (meta.humanOnly && agentId !== 0n) {
      throw new Error(
        `takeBounty(${jobId.toString()}): this bounty is humanOnly, but this wallet resolved to agentId ` +
        `${agentId.toString()}, which the adapter rejects. Pass { asHuman: true } to take it without an ` +
        "identity, or use a wallet that has none.",
      );
    }
    if (meta.requireWorkerBond) {
      // V4.2 take-window guard: taking a bond bounty with under 12h to its
      // deadline is a bond-forfeiture trap (no plausible time to deliver).
      // Enforced client-side even against pre-V4.2 deployments, which allow
      // the take on-chain. Pass skipBondTakeWindowGuard to override
      // deliberately (e.g. a task you know takes minutes, not hours).
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (!opts.skipBondTakeWindowGuard && !bondTakeWindowOk(meta.deadline, nowSec)) {
        throw new Error(
          `takeBounty(${jobId}): bond bounty has under 12h to its deadline (MIN_BOND_TAKE_WINDOW) - ` +
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

  /** Worker challenges a pending rejection - flips bounty into dispute with worker as initiator. */
  async challengeRejection(jobId: bigint, evidence: DisputeEvidenceOptions): Promise<TxResult> {
    const cid = await this._resolveEvidenceCid(evidence);
    return this._writeAdapter("challengeRejection", [jobId, cid]);
  }

  /** Open a dispute (either party - after submission, before resolution). */
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
   * this - it excludes any bounty whose deadline has already passed by
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
      if (meta.submittedResultHash.length > 0) continue; // has a submission - expireBounty rejects this
      if (category && meta.category !== category) continue;
      if (meta.deadline >= now) continue;

      try {
        await this._writeAdapter("expireBounty", [jobId]);
        expired.push(jobId);
      } catch {
        // already expired/resolved by someone else - skip
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
   * a completed bounty to this agent. Costs N real funded wallets to fake N -
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
    const id = await this.resolveAgentId();
    if (id === null) {
      throw new Error(
        `No ERC-8004 identity found for ${this.address} on ${this.network.name}. Call register() (idempotent), ` +
        "or pin a known id via the `agentId` config option / AGENT_ID env var.",
      );
    }
    // Prefer the URI the registry actually holds over the constructor's copy,
    // which is empty for every process that did not itself register.
    const [reputation, onChainURI] = await Promise.all([
      this.getReputation(id),
      this.publicClient
        .readContract({
          address: this.network.contracts.IDENTITY_REGISTRY,
          abi: IDENTITY_REGISTRY_ABI,
          functionName: "tokenURI",
          args: [id],
        })
        .catch(() => ""),
    ]);
    return {
      agentId: id,
      address: this.address,
      metadataURI: onChainURI || this.metadataURI,
      reputation,
    };
  }

  // ─── USDC helpers ────────────────────────────────────────────────────────────

  async usdcBalance(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.network.contracts.USDC,
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
   * passes the filter. Returns an `unwatch()` function - call it to stop.
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
   *    callback, a rejection is only logged, never auto-challenged - silently
   *    auto-disputing every rejection would be its own failure mode.
   *  - **Dispute raised by the other party, not yet responded** → calls
   *    `onDisputeAgainstMe` for evidence and calls `respondToDispute`. Same
   *    caveat: no callback means log-only.
   *  - **Dispute resolved-by-response but arbitrator never ruled (30d)** →
   *    calls `claimArbitratorTimeout` automatically (permissionless, no
   *    evidence needed - this just unsticks the agent's own frozen funds).
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

  /**
   * Read-only scan of this agent's own bounties (posted or assigned, via
   * `getMyBounties()`) for anything needing attention: a dispute raised
   * against it with no response yet, a pending rejection not yet challenged,
   * or funds it can now unstick permissionlessly (auto-approve / arbitrator
   * timeout). No transactions, no callbacks, no side effects - safe to call
   * from anywhere, including once per turn from an MCP tool. This is what
   * lets an agent that only runs on-demand (no background `protect()` loop)
   * still find out about a dispute instead of it passing silently.
   */
  async getPendingActions(): Promise<PendingAction[]> {
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
    const actions: PendingAction[] = [];

    for (const meta of mine) {
      if (meta.resolved) continue;

      // 1. Pending rejection, still within the challenge window, not yet challenged.
      if (meta.rejectedAt > 0n && !meta.inDispute && now <= meta.rejectedAt + rejectionWindow) {
        actions.push({
          kind: "rejection_pending", jobId: meta.jobId, meta,
          message: `Bounty #${meta.jobId}: poster rejected your submission - challenge it within the window or it finalizes against you.`,
        });
        continue;
      }

      // 2. Dispute open, raised by the OTHER party, this agent hasn't responded.
      if (
        meta.inDispute
        && meta.disputeResponseHash.length === 0
        && meta.disputeInitiator.toLowerCase() !== this.address.toLowerCase()
        && now <= meta.disputeRaisedAt + disputeWindow
      ) {
        actions.push({
          kind: "dispute_needs_response", jobId: meta.jobId, meta,
          message: `Bounty #${meta.jobId}: a dispute was opened against you - respond before the window closes or the other side wins by default.`,
        });
        continue;
      }

      // 3. Dispute answered on both sides but the arbitrator ghosted (V3.3).
      if (meta.inDispute && meta.disputeResponseHash.length > 0 && now > meta.disputeRaisedAt + arbitratorTimeout) {
        actions.push({
          kind: "arbitrator_timeout_claimable", jobId: meta.jobId, meta,
          message: `Bounty #${meta.jobId}: arbitrator never ruled - you can claim a default resolution now (claimArbitratorTimeout).`,
        });
        continue;
      }

      // 4. Submitted, poster silent past the approval window.
      if (meta.submittedAt > 0n && meta.rejectedAt === 0n && !meta.inDispute && now > meta.submittedAt + approvalTimeout) {
        actions.push({
          kind: "auto_approve_claimable", jobId: meta.jobId, meta,
          message: `Bounty #${meta.jobId}: poster went silent past the approval window - you can claim payout now (autoApprove).`,
        });
      }
    }

    return actions;
  }

  private async _protectOnce(options: {
    onRejection?: (meta: BountyMeta) => Promise<DisputeEvidenceOptions>;
    onDisputeAgainstMe?: (meta: BountyMeta) => Promise<DisputeEvidenceOptions>;
    onEvent?: (event: string, meta: BountyMeta) => void;
  }): Promise<void> {
    const onEvent = options.onEvent ?? defaultOnEvent;
    const actions = await this.getPendingActions();

    for (const action of actions) {
      try {
        switch (action.kind) {
          case "rejection_pending":
            onEvent("rejection_pending", action.meta);
            if (options.onRejection) {
              const evidence = await options.onRejection(action.meta);
              await this.challengeRejection(action.jobId, evidence);
              onEvent("rejection_challenged", action.meta);
            }
            break;

          case "dispute_needs_response":
            onEvent("dispute_needs_response", action.meta);
            if (options.onDisputeAgainstMe) {
              const evidence = await options.onDisputeAgainstMe(action.meta);
              await this.respondToDispute(action.jobId, evidence);
              onEvent("dispute_responded", action.meta);
            }
            break;

          case "arbitrator_timeout_claimable":
            await this.claimArbitratorTimeout(action.jobId);
            onEvent("arbitrator_timeout_claimed", action.meta);
            break;

          case "auto_approve_claimable":
            await this.autoApprove(action.jobId);
            onEvent("auto_approved", action.meta);
            break;
        }
      } catch (err) {
        console.error(`[ArcBountyAgent.protect] error handling bounty #${action.jobId}:`, err);
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

  /**
   * Wait for a receipt, but never forever.
   *
   * viem builds transactions from the *pending* nonce, and a load-balanced RPC
   * can serve that tag from a lagging replica. Measured on Base's public
   * endpoint 2026-08-28: `latest=27` and `pending=24` from the same host,
   * seconds apart. A transaction built on that stale nonce can never be
   * included, so an untimed `waitForTransactionReceipt` waits for a receipt
   * that will never exist - and every write in this SDK sat on that wait. Over
   * MCP it looked like the tool call itself had frozen, with no hash, no error
   * and nothing to retry against.
   *
   * The timeout turns that into something a caller can act on: it names the
   * hash, so the transaction can be looked up or resent, and it names the
   * cause, because "set a dedicated RPC" is the actual fix.
   */
  private async _waitForTx(hash: Hash): Promise<void> {
    try {
      await this.publicClient.waitForTransactionReceipt({ hash, timeout: TX_RECEIPT_TIMEOUT_MS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Transaction ${hash} was sent but no receipt arrived within ` +
        `${TX_RECEIPT_TIMEOUT_MS / 1000}s on ${this.network.name}. It may still be pending, or it may ` +
        "have been built on a stale nonce by a lagging RPC replica and can never be included - check the " +
        "hash on the explorer before resending. A dedicated RPC endpoint avoids this; the public one is " +
        `load balanced. Underlying error: ${msg}`,
      );
    }
  }

  /**
   * Write to BountyAdapter with the canonical (chain, account) tuple. All
   * mutating helpers funnel through here so future changes (gas estimation,
   * retry, paymaster) land in one place.
   */
  /**
   * Estimate this call's gas and add half again, or return undefined and let
   * viem estimate as before.
   *
   * The adapter records ERC-8004 feedback inside a `try/catch`, deliberately:
   * a reputation write must never block a payout that already happened. But
   * `eth_estimateGas` binary-searches for the *lowest* limit at which the
   * transaction succeeds, and the outer call succeeds whether or not the inner
   * one runs out of gas - so the search settles on a limit where the feedback
   * silently fails. Measured on Base mainnet 2026-08-28: approveBounty at the
   * estimated limit emitted nothing from the registry, and the same call at
   * three times that limit emitted the feedback and used 316k gas. Every
   * approval had been quietly skipping the reputation write.
   *
   * Unused gas is refunded, so the buffer costs nothing but a slightly higher
   * balance requirement at send time.
   */
  private async _gasWithBuffer(functionName: string, args: readonly unknown[]): Promise<bigint | undefined> {
    try {
      const estimate = await this.publicClient.estimateContractGas({
        address: this.bountyAdapter,
        abi: BOUNTY_ADAPTER_ABI,
        functionName,
        args,
        account: this.signer.address,
      } as Parameters<typeof this.publicClient.estimateContractGas>[0]);
      return (estimate * 3n) / 2n;
    } catch {
      // Estimation can fail for reasons that are not this call's problem (a
      // rate-limited node, say). Falling back to viem's own estimate keeps the
      // write working; it only loses the buffer.
      return undefined;
    }
  }

  private async _writeAdapter(functionName: string, args: readonly unknown[]): Promise<TxResult> {
    const gas = await this._gasWithBuffer(functionName, args);
    const hash = await this.signer.writeContract({
      address: this.bountyAdapter,
      abi: BOUNTY_ADAPTER_ABI,
      functionName,
      args,
      ...(gas !== undefined ? { gas } : {}),
    });
    await this._waitForTx(hash);
    return { hash };
  }

  /**
   * Best-effort discovery: scan a bounded recent window for a
   * Transfer(0x0 → self) on the registry. Every public RPC we target caps
   * eth_getLogs at a 10,000-block range per call (Arc's, Base's own
   * mainnet.base.org, and drpc all reject a wider request outright), so we page
   * backward in 10k chunks up to a lookback ceiling instead of issuing one
   * oversized request.
   *
   * `scanned` distinguishes "completed and found nothing" from "gave up": the
   * caller must not treat an RPC failure as proof that no identity exists, or
   * `register()` mints a duplicate and orphans the first identity's reputation.
   *
   * The ceiling is expressed in DAYS and converted via the network's
   * `blocksPerDay`. A flat 500k-block window meant ~5.8 days on Arc but only
   * ~11.6 days on Base, and would shrink further on any faster chain; the call
   * budget keeps a miss cheap where that window runs to thousands of requests.
   * This is why production should pin `agentId` / AGENT_ID rather than rely on
   * discovery at all.
   */
  private async _findExistingAgentId(): Promise<{ agentId: bigint | null; scanned: boolean }> {
    const CHUNK = 10_000n; // The eth_getLogs range cap public RPCs enforce.
    const MAX_CALLS = 24n; // Bounded RPC budget - see doc comment.
    const LOOKBACK_DAYS = 30n;
    const wanted = BigInt(Math.max(1, Math.round(this.network.blocksPerDay))) * LOOKBACK_DAYS;
    const lookback = wanted > CHUNK * MAX_CALLS ? CHUNK * MAX_CALLS : wanted;

    try {
      const head = await this.publicClient.getBlockNumber();
      const floor = head > lookback ? head - lookback : 0n;

      for (let to = head; to > floor; to -= CHUNK) {
        const from = to - CHUNK + 1n > floor ? to - CHUNK + 1n : floor;
        const logs = await this.publicClient.getLogs({
          address: this.network.contracts.IDENTITY_REGISTRY,
          event: IDENTITY_TRANSFER_EVENT,
          args: { from: ZERO_ADDRESS, to: this.address },
          fromBlock: from,
          toBlock: to,
        });
        if (logs.length > 0) {
          const last = logs[logs.length - 1]!;
          return { agentId: (last.args as { tokenId: bigint }).tokenId, scanned: true };
        }
        if (from === floor) break;
      }
      return { agentId: null, scanned: true };
    } catch {
      return { agentId: null, scanned: false };
    }
  }

  private async _ensureUsdcAllowance(amount: bigint): Promise<void> {
    const current = await this.publicClient.readContract({
      address: this.network.contracts.USDC,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.address, this.bountyAdapter],
    });
    if (current >= amount) return;

    const hash = await this.signer.writeContract({
      address: this.network.contracts.USDC,
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
