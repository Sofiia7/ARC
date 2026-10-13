import { zeroAddress, type Address, type Hex } from "viem";
import {
  adapterAbi,
  identityAbi,
  mirrorAbi,
  unwrap,
  type BountyMeta,
  type Call,
  type ChainClient,
  type ContestEntry,
  type ContestStateTuple,
  type MirrorRecordTuple,
  type PinnedBlock,
  type TotalsTuple,
} from "./chain.js";
import { CachedValue, TtlMap, withTimeout, type Clock } from "./cache.js";
import type { Config } from "./config.js";
import { LIMITS, TIMEOUT, TTL } from "./constants.js";
import { buildContestBody } from "./contest.js";
import { buildReputationBody, MIRROR_SOURCES } from "./identityReputation.js";
import { snapshotHeader } from "./snapshot.js";
import {
  buildWorkersBody,
  collectCandidates,
  type GateParams,
  type WorkerIdentity,
  type WorkerScan,
} from "./workers.js";

export type JobInfo = { contest: boolean };
type Immutables = { identity: Address; mirror: Address; feeBps: bigint };

const adapterCall = (config: Config, functionName: string, args: readonly unknown[] = []): Call => ({
  address: config.adapter,
  abi: adapterAbi,
  functionName,
  args,
});

/**
 * Every on-chain read behind the paid routes. Unpaid probes only ever touch the small caches here (the highest job ID,
 * jobs already seen); the real reads run after a payment is verified and all use one pinned block.
 */
export class ChainReader {
  private immutables?: Promise<Immutables>;
  private readonly pinnedBlock: CachedValue<PinnedBlock>;
  private readonly highestJobId: CachedValue<bigint>;
  private readonly knownJobs: TtlMap<bigint, JobInfo>;
  private readonly missingJobs: TtlMap<bigint, true>;
  private readonly missingAgents: TtlMap<bigint, true>;
  private readonly workerScans: TtlMap<string, Promise<WorkerScan>>;
  private readonly lookups = new Map<bigint, Promise<JobInfo | undefined>>();

  constructor(
    private readonly chain: ChainClient,
    private readonly config: Config,
    now: Clock = Date.now,
  ) {
    this.pinnedBlock = new CachedValue({
      load: () => chain.getBlock(),
      ttlMs: TTL.pinnedBlock,
      timeoutMs: TIMEOUT.rpcStep,
      now,
    });
    this.highestJobId = new CachedValue({
      load: () => this.loadHighestJobId(),
      ttlMs: TTL.maxJobId,
      timeoutMs: TIMEOUT.rpcStep,
      maxStaleMs: 5 * 60_000,
      now,
    });
    this.knownJobs = new TtlMap(5000, TTL.knownJob, now);
    this.missingJobs = new TtlMap(5000, TTL.missingJob, now);
    this.missingAgents = new TtlMap(5000, TTL.missingAgent, now);
    this.workerScans = new TtlMap(4, TTL.workerScan, now);
  }

  private get context() {
    return { chainId: this.config.chainId, adapter: this.config.adapter };
  }

  /** The block every paid read is pinned to. Up to five seconds old unless `maxAgeMs` asks for fresher. */
  pinned(maxAgeMs?: number): Promise<PinnedBlock> {
    return this.pinnedBlock.get(maxAgeMs);
  }

  private getImmutables(): Promise<Immutables> {
    this.immutables ??= (async () => {
      const [identity, mirror, feeBps] = await this.chain.call([
        adapterCall(this.config, "identityRegistry"),
        adapterCall(this.config, "reputationMirror"),
        adapterCall(this.config, "feeBps"),
      ]);
      return {
        identity: unwrap<Address>(identity, "identityRegistry"),
        mirror: unwrap<Address>(mirror, "reputationMirror"),
        feeBps: unwrap<bigint>(feeBps, "feeBps"),
      };
    })().catch((error) => {
      this.immutables = undefined;
      throw error;
    });
    return this.immutables;
  }

  private async loadHighestJobId(): Promise<bigint> {
    const [total] = await this.chain.call([adapterCall(this.config, "totalBounties")]);
    const count = unwrap<bigint>(total, "totalBounties");
    if (count === 0n) return 0n;
    // allJobIds grows with the escrow's job counter, so its last element is the highest ID this adapter holds.
    const [last] = await this.chain.call([adapterCall(this.config, "allJobIds", [count - 1n])]);
    return unwrap<bigint>(last, "allJobIds");
  }

  /**
   * Cheap existence check for an unpaid probe. No RPC when the job is above the cached highest ID or already seen;
   * otherwise one read per job ever (jobs are never deleted, so a hit is cached for ten minutes).
   */
  async lookupJob(jobId: bigint): Promise<JobInfo | undefined> {
    const known = this.knownJobs.get(jobId);
    if (known) return known;
    if (this.missingJobs.get(jobId)) return undefined;
    // Concurrent probes of the same job share one resolution.
    let pending = this.lookups.get(jobId);
    if (!pending) {
      pending = this.resolveJob(jobId).finally(() => this.lookups.delete(jobId));
      this.lookups.set(jobId, pending);
    }
    return pending;
  }

  private async resolveJob(jobId: bigint): Promise<JobInfo | undefined> {
    let highest = await this.highestJobId.get();
    if (jobId > highest) {
      // The cached maximum may predate a brand-new bounty: allow one bounded refresh before saying no.
      highest = await this.highestJobId.get(TTL.maxJobIdRecheck);
      if (jobId > highest) {
        this.missingJobs.set(jobId, true);
        return undefined;
      }
    }
    // Latest block, not the pinned one: the pinned block may be a few seconds older than the job.
    const [result] = await this.chain.call([adapterCall(this.config, "getBountyMeta", [jobId])]);
    const meta = unwrap<BountyMeta>(result, "getBountyMeta");
    if (meta.poster === zeroAddress) {
      this.missingJobs.set(jobId, true);
      return undefined;
    }
    const info = { contest: meta.contest };
    this.knownJobs.set(jobId, info);
    return info;
  }

  /** Agent IDs a paid read already found missing; lets repeat probes be rejected without an RPC. */
  isKnownMissingAgent(agentId: bigint): boolean {
    return this.missingAgents.get(agentId) === true;
  }

  /** The full bounty record and (for contests) its entries, pinned to one block. */
  async bountySnapshot(jobId: bigint) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const block = await this.pinned(attempt === 0 ? undefined : 500);
      const calls = [adapterCall(this.config, "getBountyMeta", [jobId])];
      if (this.knownJobs.get(jobId)?.contest) calls.push(adapterCall(this.config, "getContestEntries", [jobId]));
      const [metaResult, entriesResult] = await this.chain.call(calls, block.number);
      const meta = unwrap<BountyMeta>(metaResult, "getBountyMeta");
      // A pinned block that predates the job is retried once on a fresher block before giving up.
      if (meta.poster === zeroAddress) continue;
      let entries: readonly ContestEntry[] = [];
      if (meta.contest) {
        entries = entriesResult
          ? unwrap<readonly ContestEntry[]>(entriesResult, "getContestEntries")
          : unwrap<readonly ContestEntry[]>(
              (await this.chain.call([adapterCall(this.config, "getContestEntries", [jobId])], block.number))[0],
              "getContestEntries",
            );
      }
      return { ...snapshotHeader(this.context, block), meta, entries };
    }
    return undefined;
  }

  /** Identity, working wallet, local, Base and Arc reputation for one ERC-8004 agent, from one block. */
  async reputationSnapshot(agentId: bigint) {
    const { identity, mirror } = await this.getImmutables();
    const block = await this.pinned();
    const [ownerResult, walletResult, keyResult] = await this.chain.call(
      [
        { address: identity, abi: identityAbi, functionName: "ownerOf", args: [agentId] },
        { address: identity, abi: identityAbi, functionName: "getAgentWallet", args: [agentId] },
        adapterCall(this.config, "identityKey", [agentId, zeroAddress]),
      ],
      block.number,
    );
    // ownerOf reverts for a token that does not exist; the adapter treats that (and the zero address) as no identity.
    const owner = ownerResult.status === "success" ? (ownerResult.result as Address) : undefined;
    if (!owner || owner === zeroAddress) {
      this.missingAgents.set(agentId, true);
      return undefined;
    }
    const workingWallet = walletResult.status === "success" ? (walletResult.result as Address) : null;
    const key = unwrap<Hex>(keyResult, "identityKey");
    const parts = await this.chain.call(
      [
        adapterCall(this.config, "localReputation", [key]),
        ...MIRROR_SOURCES.map((source) => ({
          address: mirror,
          abi: mirrorAbi,
          functionName: "records",
          args: [owner, source.sourceChain],
        })),
        adapterCall(this.config, "getIdentityReputation", [agentId, zeroAddress]),
      ],
      block.number,
    );
    const localTotals = unwrap<TotalsTuple>(parts[0], "localReputation");
    const records = MIRROR_SOURCES.map((_, index) => {
      const record = unwrap<MirrorRecordTuple>(parts[1 + index], "mirror records");
      return { paidJobs: record[0], scoreSum: record[1], sourceBlock: record[2], updatedAt: record[3] };
    });
    const onChain = unwrap<TotalsTuple>(parts[1 + MIRROR_SOURCES.length], "getIdentityReputation");
    return buildReputationBody({
      context: this.context,
      block,
      agentId,
      identityOwner: owner,
      workingWallet,
      mirror,
      local: { paidJobs: localTotals[0], scoreSum: localTotals[1] },
      records,
      onChainTotals: { paidJobs: onChain[0], scoreSum: onChain[1] },
    });
  }

  /** Result view of one contest. Returns undefined when the job is missing and 'not-contest' for plain bounties. */
  async contestResult(jobId: bigint): Promise<ReturnType<typeof buildContestBody> | "not-contest" | undefined> {
    const { identity, feeBps } = await this.getImmutables();
    for (let attempt = 0; attempt < 2; attempt++) {
      const block = await this.pinned(attempt === 0 ? undefined : 500);
      const [metaResult] = await this.chain.call([adapterCall(this.config, "getBountyMeta", [jobId])], block.number);
      const meta = unwrap<BountyMeta>(metaResult, "getBountyMeta");
      if (meta.poster === zeroAddress) continue;
      if (!meta.contest) return "not-contest";
      const [entriesResult, stateResult, challengersResult] = await this.chain.call(
        [
          adapterCall(this.config, "getContestEntries", [jobId]),
          adapterCall(this.config, "getContestState", [jobId]),
          adapterCall(this.config, "getContestChallengers", [jobId]),
        ],
        block.number,
      );
      const entries = unwrap<readonly ContestEntry[]>(entriesResult, "getContestEntries");
      const agentIds = [...new Set(entries.filter((entry) => entry.agentId !== 0n).map((entry) => entry.agentId))];
      const ownerResults = await this.chain.call(
        agentIds.map((agentId) => ({ address: identity, abi: identityAbi, functionName: "ownerOf", args: [agentId] })),
        block.number,
      );
      const owners = new Map<bigint, Address | null>(
        agentIds.map((agentId, index) => {
          const result = ownerResults[index];
          return [
            agentId,
            result.status === "success" && result.result !== zeroAddress ? (result.result as Address) : null,
          ];
        }),
      );
      return buildContestBody({
        context: this.context,
        block,
        jobId,
        meta,
        entries,
        contestState: unwrap<ContestStateTuple>(stateResult, "getContestState"),
        challengers: unwrap<readonly number[]>(challengersResult, "getContestChallengers"),
        feeBps,
        owners,
      });
    }
    return undefined;
  }

  /** The verified-worker list for one gate. The expensive scan is shared per pinned block and independent of the gate. */
  async verifiedWorkers(gate: GateParams) {
    const block = await this.pinned();
    const key = block.number.toString();
    let scan = this.workerScans.get(key);
    if (!scan) {
      scan = withTimeout(this.scanWorkers(block), LIMITS.handlerDeadlineMs);
      this.workerScans.set(key, scan);
      scan.catch(() => this.workerScans.delete(key));
    }
    return buildWorkersBody(this.context, await scan, gate);
  }

  private async scanWorkers(block: PinnedBlock): Promise<WorkerScan> {
    const { identity } = await this.getImmutables();
    const at = block.number;
    const [totalResult] = await this.chain.call([adapterCall(this.config, "totalBounties")], at);
    const totalJobs = unwrap<bigint>(totalResult, "totalBounties");
    const jobsScanned = Number(totalJobs < BigInt(LIMITS.workerScanJobs) ? totalJobs : BigInt(LIMITS.workerScanJobs));

    const idResults = await this.chain.call(
      Array.from({ length: jobsScanned }, (_, index) => adapterCall(this.config, "allJobIds", [BigInt(index)])),
      at,
    );
    const jobIds = idResults.map((result) => unwrap<bigint>(result, "allJobIds"));
    const metaResults = await this.chain.call(
      jobIds.map((jobId) => adapterCall(this.config, "getBountyMeta", [jobId])),
      at,
    );
    const metas = metaResults.map((result) => unwrap<BountyMeta>(result, "getBountyMeta"));

    const contestIndexes = metas.flatMap((meta, index) => (meta.contest ? [index] : []));
    const entryResults = await this.chain.call(
      contestIndexes.map((index) => adapterCall(this.config, "getContestEntries", [jobIds[index]])),
      at,
    );
    const entriesByIndex = new Map(
      contestIndexes.map((index, position) => [
        index,
        unwrap<readonly ContestEntry[]>(entryResults[position], "getContestEntries"),
      ]),
    );
    const { candidates, truncated } = collectCandidates(
      metas.map((meta, index) => ({ meta, entries: entriesByIndex.get(index) })),
    );

    // One stage for every candidate: agents need owner, working wallet and totals; humans only their totals.
    const calls: Call[] = [];
    for (const candidate of candidates) {
      if (candidate.kind === "agent") {
        calls.push(
          { address: identity, abi: identityAbi, functionName: "ownerOf", args: [candidate.agentId] },
          { address: identity, abi: identityAbi, functionName: "getAgentWallet", args: [candidate.agentId] },
          adapterCall(this.config, "getIdentityReputation", [candidate.agentId, zeroAddress]),
        );
      } else {
        calls.push(adapterCall(this.config, "getIdentityReputation", [0n, candidate.wallet]));
      }
    }
    const results = await this.chain.call(calls, at);
    const identities: WorkerIdentity[] = [];
    let unresolved = 0;
    let cursor = 0;
    for (const candidate of candidates) {
      if (candidate.kind === "agent") {
        const [owner, wallet, totals] = results.slice(cursor, cursor + 3);
        cursor += 3;
        // A reverting registry or totals read means the adapter itself cannot resolve this identity.
        if (owner.status !== "success" || owner.result === zeroAddress || totals.status !== "success") {
          unresolved++;
          continue;
        }
        const [paidJobs, scoreSum] = totals.result as TotalsTuple;
        const workingWallet =
          wallet.status === "success" && wallet.result !== zeroAddress ? (wallet.result as Address) : null;
        identities.push({
          kind: "agent",
          agentId: candidate.agentId,
          owner: owner.result as Address,
          workingWallet,
          paidJobs,
          scoreSum,
        });
      } else {
        const totals = results[cursor++];
        if (totals.status !== "success") {
          unresolved++;
          continue;
        }
        const [paidJobs, scoreSum] = totals.result as TotalsTuple;
        identities.push({ kind: "human", wallet: candidate.wallet, paidJobs, scoreSum });
      }
    }
    return { block, totalJobs, jobsScanned, identities, identitiesTruncated: truncated, unresolved };
  }
}
