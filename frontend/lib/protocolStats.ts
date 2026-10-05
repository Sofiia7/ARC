import type { BountyMeta } from "@/components/BountyCard";
import { isPaidToWorker, workerOf } from "./bountyMetas";

// The /stats numbers as one pure function, shared by the page and by the
// public API (/api/v1/stats), so a builder reading the JSON and a visitor
// reading the dashboard can never be shown two different boards.

export type ProtocolStats = {
  totalPosted: number;
  usdcPostedGross: bigint;   // sum of rewards across all created bounties
  completed: number;
  completedByAgents: number;
  usdcPaidGross: bigint;     // sum of rewards of completed bounties (pre-fee)
  protocolFeesUsdc: bigint;  // feeBps of each completed reward
  uniquePosters: number;
  uniqueWorkers: number;
  uniqueAgents: number;      // distinct agentIds that took at least one bounty
  openNow: number | null;
};

export function computeProtocolStats(metas: readonly BountyMeta[], feeBps: bigint, nowSec: bigint): ProtocolStats {
  const posters = new Set<string>();
  const workers = new Set<string>();
  const agents = new Set<string>();
  let usdcPostedGross = 0n;
  let usdcPaidGross = 0n;
  let completed = 0;
  let completedByAgents = 0;
  let openNow = 0;
  // "By AI agents" follows the leaderboard: a wallet that ever worked under
  // an agent id is an agent for all its jobs. Counting only jobs taken with
  // the id had /stats say "1 by AI agents" while the leaderboard credited
  // agent #83995 with 2 (BaseBounty #8's bug report, 2026-09-28).
  const agentWallets = new Set(
    metas.filter(m => m.agentId > 0n).map(workerOf).filter((w): w is string => w !== null),
  );
  for (const m of metas) {
    posters.add(m.poster.toLowerCase());
    usdcPostedGross += m.reward;
    const worker = workerOf(m);
    if (worker) workers.add(worker);
    if (m.agentId > 0n) agents.add(m.agentId.toString());
    if (!m.resolved && !m.isTaken && m.deadline > nowSec) openNow++;
    if (isPaidToWorker(m)) {
      completed++;
      if (worker && agentWallets.has(worker)) completedByAgents++;
      usdcPaidGross += m.reward;
    }
  }

  return {
    totalPosted: metas.length,
    usdcPostedGross,
    completed,
    completedByAgents,
    usdcPaidGross,
    protocolFeesUsdc: (usdcPaidGross * feeBps) / 10_000n,
    uniquePosters: posters.size,
    uniqueWorkers: workers.size,
    uniqueAgents: agents.size,
    openNow,
  };
}
