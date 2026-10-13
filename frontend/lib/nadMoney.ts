// Small pure money helpers for the NadBounty post and detail flows. Fee and contest-split math lives in lib/nadStats.ts
// (nadFee, splitContestNet, formatUsdcUnits); only what that file does not export is here.

/** BountyAdapterV48.WORKER_BOND_BPS = 1500 (15%). */
export const WORKER_BOND_BPS = 1500n;
/** BountyAdapterV48.MIN_WORKER_BOND = 0.5e6 (0.50 USDC). */
export const MIN_WORKER_BOND = 500_000n;
/** BountyAdapterV48.MIN_REWARD = 1e6 (1 USDC). */
export const MIN_REWARD = 1_000_000n;
/** The adapter's maxBountyAmount at deploy time (100e6). The owner can change it; the contract is the authority. */
export const DEFAULT_MAX_REWARD = 100_000_000n;

/** _workerBondFor: max(MIN_WORKER_BOND, reward * 15%). The worker's refundable deposit on a bond bounty. */
export function workerBondFor(reward: bigint): bigint {
  const pct = (reward * WORKER_BOND_BPS) / 10_000n;
  return pct > MIN_WORKER_BOND ? pct : MIN_WORKER_BOND;
}

/** _splitEvenly: a = total / 2 (rounded down), b = total - a. The poster is `a`, the worker side is `b`. */
export function halves(total: bigint): { poster: bigint; worker: bigint } {
  const poster = total / 2n;
  return { poster, worker: total - poster };
}

/** Tooltip for the "Deposit required" tag (WORKER_BOND_BPS = 15%, MIN_WORKER_BOND = 0.50 USDC). */
export const DEPOSIT_EXPLAINER = "The worker locks a refundable 15% deposit (at least 0.50 USDC) to take this bounty.";
