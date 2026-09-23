"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI, BOUNTY_ADAPTER_DEPLOY_BLOCK } from "@/lib/contracts";
import { getLogsChunked } from "@/lib/chainLogs";
import { fetchAllBountyMetas, isPaidToWorker, workerOf } from "@/lib/bountyMetas";

export type CompletedRecord = {
  jobId:           bigint;
  agentId:         bigint;          // 0 = taken without an agent identity
  worker:          string;          // lowercase wallet that did the job
  poster:          string;          // lowercase wallet that paid for it
  reward:          bigint;          // gross reward (6-decimal USDC)
  submittedAt:     bigint;          // unix seconds
  reputationScore: bigint | null;   // the score the payout wrote; null when the log scan failed
};

const BOUNTY_COMPLETED = BOUNTY_ADAPTER_ABI.find(
  e => e.type === "event" && e.name === "BountyCompleted",
)!;

/**
 * Every paid bounty, from the adapter's storage (lib/bountyMetas.ts), so the
 * leaderboard can never come out empty just because a log scan did. The one
 * thing storage does not keep, the reputation score each payout wrote, is
 * joined in from BountyCompleted logs when that scan works and left null when
 * it does not.
 */
export function useCompletedBounties() {
  const publicClient = usePublicClient();

  return useQuery<CompletedRecord[]>({
    queryKey: ["completed-bounties", CONTRACTS.BOUNTY_ADAPTER],
    enabled: !!publicClient,
    staleTime: 60_000,
    queryFn: async () => {
      if (!publicClient) return [];
      const [metas, scores] = await Promise.all([
        fetchAllBountyMetas(publicClient),
        getLogsChunked(
          publicClient,
          { address: CONTRACTS.BOUNTY_ADAPTER, event: BOUNTY_COMPLETED as never },
          BOUNTY_ADAPTER_DEPLOY_BLOCK,
        ).then(
          logs => {
            const byJob = new Map<string, bigint>();
            for (const l of logs) {
              const a = l.args as { jobId: bigint; reputationScore: bigint };
              byJob.set(a.jobId.toString(), a.reputationScore);
            }
            return byJob;
          },
          () => new Map<string, bigint>(),
        ),
      ]);

      return metas.filter(isPaidToWorker).map(m => ({
        jobId:           m.jobId,
        agentId:         m.agentId,
        worker:          workerOf(m)!,
        poster:          m.poster.toLowerCase(),
        reward:          m.reward,
        submittedAt:     m.submittedAt,
        reputationScore: scores.get(m.jobId.toString()) ?? null,
      }));
    },
  });
}

export type WorkerStats = {
  worker:          string;
  /** The agent identity this wallet worked under; 0n if it never used one. */
  agentId:         bigint;
  jobsDone:        number;
  lastJobAt:       bigint; // unix seconds
  /**
   * V4_DESIGN_ANTI_SYBIL.md Proposal B2 - a sqrt(reward)-weighted average of
   * the reputation scores of this worker's payouts. sqrt (not linear) dampens
   * one whale bounty while still weighting a $50 job above a $1 one. Null when
   * no score is known (human workers, or the log scan failed).
   */
  weightedScore:   number | null;
  totalVolumeUsdc: number;
  /** Distinct wallets that paid this worker: N of them cost N funded wallets to fake. */
  uniquePosters:   number;
};

/**
 * One row per worker wallet, agents and humans alike. A wallet that did some
 * jobs with its agent identity and some without is still one worker: all its
 * jobs count, under its agent id.
 */
export function aggregateWorkerStats(records: CompletedRecord[]): WorkerStats[] {
  const byWorker = new Map<string, {
    agentId: bigint; count: number; last: bigint; volume: bigint;
    weightedSum: number; weightTotal: number; posters: Set<string>;
  }>();
  for (const r of records) {
    const cur = byWorker.get(r.worker)
      ?? { agentId: 0n, count: 0, last: 0n, volume: 0n, weightedSum: 0, weightTotal: 0, posters: new Set<string>() };
    if (r.agentId > 0n) cur.agentId = r.agentId;
    cur.count += 1;
    cur.volume += r.reward;
    cur.posters.add(r.poster);
    if (r.submittedAt > cur.last) cur.last = r.submittedAt;
    if (r.reputationScore !== null) {
      const weight = Math.sqrt(Math.max(Number(r.reward) / 1e6, 0));
      cur.weightedSum += Number(r.reputationScore) * weight;
      cur.weightTotal += weight;
    }
    byWorker.set(r.worker, cur);
  }
  const out: WorkerStats[] = [];
  for (const [worker, v] of byWorker) {
    out.push({
      worker,
      agentId:         v.agentId,
      jobsDone:        v.count,
      lastJobAt:       v.last,
      weightedScore:   v.weightTotal === 0 ? null : v.weightedSum / v.weightTotal,
      totalVolumeUsdc: Number(v.volume) / 1e6,
      uniquePosters:   v.posters.size,
    });
  }
  out.sort((a, b) => b.jobsDone - a.jobsDone || b.totalVolumeUsdc - a.totalVolumeUsdc);
  return out;
}
