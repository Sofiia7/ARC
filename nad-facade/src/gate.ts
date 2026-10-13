import { TIERS } from "./constants.js";

/**
 * The adapter's reputation gate (_checkGate), in integer math. A worker passes unless
 *   jobs < minJobs  ||  (jobs == 0 && minAvgScore != 0)  ||  scoreSum < minAvgScore * jobs.
 * A gate with both thresholds at zero is disabled. The average is never divided, so scoreSum == minAvgScore * jobs
 * (exactly on the boundary) passes and one point less does not.
 */
export function gatePasses(paidJobs: bigint, scoreSum: bigint, minJobs: bigint, minAvgScore: bigint): boolean {
  if (minJobs === 0n && minAvgScore === 0n) return true;
  return !(paidJobs < minJobs || (paidJobs === 0n && minAvgScore !== 0n) || scoreSum < minAvgScore * paidJobs);
}

export function tierGates(paidJobs: bigint, scoreSum: bigint) {
  const evaluate = (tier: { minJobs: number; minAvgScore: number }) => ({
    minJobs: tier.minJobs,
    minAvgScore: tier.minAvgScore,
    passes: gatePasses(paidJobs, scoreSum, BigInt(tier.minJobs), BigInt(tier.minAvgScore)),
  });
  return { proven: evaluate(TIERS.proven), top: evaluate(TIERS.top) };
}
