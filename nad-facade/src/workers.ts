import { zeroAddress, type Address } from "viem";
import type { BountyMeta, ContestEntry, PinnedBlock } from "./chain.js";
import { LIMITS } from "./constants.js";
import { averageScore } from "./format.js";
import { gatePasses, tierGates } from "./gate.js";
import { snapshotHeader, type SnapshotContext } from "./snapshot.js";

export type Candidate = { kind: "agent"; agentId: bigint } | { kind: "human"; wallet: Address };
export type ScannedJob = { meta: BountyMeta; entries?: readonly ContestEntry[] };

/**
 * The candidate set: assigned providers of taken bounties and every contest entrant, in job order, de-duplicated
 * (agents by agent ID, humans by wallet). Anyone who never worked a job on this adapter is not a candidate.
 */
export function collectCandidates(
  jobs: readonly ScannedJob[],
  cap: number = LIMITS.workerScanIdentities,
): { candidates: Candidate[]; truncated: boolean } {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let truncated = false;
  const add = (agentId: bigint, wallet: Address) => {
    const key = agentId !== 0n ? `a:${agentId}` : wallet === zeroAddress ? "" : `h:${wallet.toLowerCase()}`;
    if (!key || seen.has(key)) return;
    if (candidates.length >= cap) {
      truncated = true;
      return;
    }
    seen.add(key);
    candidates.push(agentId !== 0n ? { kind: "agent", agentId } : { kind: "human", wallet });
  };
  for (const { meta, entries } of jobs) {
    if (meta.contest) for (const entry of entries ?? []) add(entry.agentId, entry.entrant);
    else if (meta.isTaken) add(meta.agentId, meta.assignedProvider);
  }
  return { candidates, truncated };
}

export type WorkerIdentity =
  | {
      kind: "agent";
      agentId: bigint;
      owner: Address;
      workingWallet: Address | null;
      paidJobs: bigint;
      scoreSum: bigint;
    }
  | { kind: "human"; wallet: Address; paidJobs: bigint; scoreSum: bigint };

export type WorkerScan = {
  block: PinnedBlock;
  totalJobs: bigint;
  jobsScanned: number;
  identities: WorkerIdentity[];
  identitiesTruncated: boolean;
  /** Candidates whose identity could not be resolved (for example a burned agent token). */
  unresolved: number;
};

export type GateParams = { minJobs: number; minAvgScore: number };

function compareWorkers(a: WorkerIdentity, b: WorkerIdentity): number {
  // Higher average first (cross-multiplied, no division), then more jobs, then a stable key.
  const left = a.scoreSum * b.paidJobs;
  const right = b.scoreSum * a.paidJobs;
  if (left !== right) return left > right ? -1 : 1;
  if (a.paidJobs !== b.paidJobs) return a.paidJobs > b.paidJobs ? -1 : 1;
  const keyA = a.kind === "agent" ? `a${a.agentId.toString().padStart(40, "0")}` : `h${a.wallet.toLowerCase()}`;
  const keyB = b.kind === "agent" ? `a${b.agentId.toString().padStart(40, "0")}` : `h${b.wallet.toLowerCase()}`;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

export function buildWorkersBody(context: SnapshotContext, scan: WorkerScan, gate: GateParams) {
  const passing = scan.identities
    .filter((identity) =>
      gatePasses(identity.paidJobs, identity.scoreSum, BigInt(gate.minJobs), BigInt(gate.minAvgScore)),
    )
    .sort(compareWorkers);
  const totals = (identity: WorkerIdentity) => ({
    paidJobs: identity.paidJobs.toString(),
    scoreSum: identity.scoreSum.toString(),
    averageScore: averageScore(identity.paidJobs, identity.scoreSum),
    tiers: Object.fromEntries(
      Object.entries(tierGates(identity.paidJobs, identity.scoreSum)).map(([name, tier]) => [name, tier.passes]),
    ),
  });
  return {
    ...snapshotHeader(context, scan.block),
    gate: {
      minJobs: gate.minJobs,
      minAvgScore: gate.minAvgScore,
      rule: "paidJobs >= minJobs and scoreSum >= minAvgScore * paidJobs (integer math, the same check the adapter applies when a worker takes a bounty)",
    },
    count: passing.length,
    workers: passing.map((identity) =>
      identity.kind === "agent"
        ? {
            kind: "agent",
            agentId: identity.agentId.toString(),
            identityOwner: identity.owner,
            workingWallet: identity.workingWallet,
            ...totals(identity),
          }
        : { kind: "human", wallet: identity.wallet, ...totals(identity) },
    ),
    scope: {
      candidateSet:
        "Assigned providers of taken bounties and contest entrants found in the first jobs of this adapter (allJobIds order). Event logs are not scanned.",
      jobsScanned: scan.jobsScanned,
      totalJobs: scan.totalJobs.toString(),
      jobCap: LIMITS.workerScanJobs,
      truncated: scan.totalJobs > BigInt(scan.jobsScanned),
      identitiesConsidered: scan.identities.length + scan.unresolved,
      identityCap: LIMITS.workerScanIdentities,
      identitiesTruncated: scan.identitiesTruncated,
      unresolvedIdentities: scan.unresolved,
      limitation: `Identities that only appear in jobs beyond the first ${LIMITS.workerScanJobs}, or whose reputation exists only on Base or Arc without a job on this adapter, are not listed. Use GET /v1/reputation/{agentId} to check a specific identity.`,
    },
  };
}
