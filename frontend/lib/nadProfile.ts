// Pure NadBounty profile helpers. No React, no wagmi, no browser APIs: safe to import from node:test.
import { isAddress, type Address } from "viem";

// ---- reputation gates ---------------------------------------------------------------------------------------

export type GatePreset = { id: "proven" | "top"; label: string; minJobs: bigint; minAvg: bigint };
/** The two gates the post form offers (lib/nadStatus.ts GATES): Proven 3 paid jobs and 80 average, Top 10 and 90. */
export const GATE_PRESETS: readonly GatePreset[] = [
  { id: "proven", label: "Proven", minJobs: 3n, minAvg: 80n },
  { id: "top", label: "Top", minJobs: 10n, minAvg: 90n },
];

export type GateCheck = {
  pass: boolean;
  jobs: bigint;
  scoreSum: bigint;
  minJobs: bigint;
  minAvg: bigint;
  /** minAvg * jobs: the score sum the contract compares against, so no integer division can admit anyone. */
  requiredSum: bigint;
  jobsOk: boolean;
  scoreOk: boolean;
};

/**
 * Mirror of BountyAdapterV48._checkGate. It reverts when
 *   jobs < minJobs || (jobs == 0 && minAvg != 0) || scoreSum < minAvg * jobs
 * and a gate with minJobs == 0 and minAvg == 0 always passes.
 */
export function checkGate(jobs: bigint, scoreSum: bigint, minJobs: bigint, minAvg: bigint): GateCheck {
  const requiredSum = minAvg * jobs;
  if (minJobs === 0n && minAvg === 0n)
    return { pass: true, jobs, scoreSum, minJobs, minAvg, requiredSum, jobsOk: true, scoreOk: true };
  const jobsOk = jobs >= minJobs && !(jobs === 0n && minAvg !== 0n);
  const scoreOk = scoreSum >= requiredSum;
  return { pass: jobsOk && scoreOk, jobs, scoreSum, minJobs, minAvg, requiredSum, jobsOk, scoreOk };
}

/** Highest tier the totals reach, or null. */
export function tierOf(jobs: bigint, scoreSum: bigint): "Top" | "Proven" | null {
  if (checkGate(jobs, scoreSum, 10n, 90n).pass) return "Top";
  if (checkGate(jobs, scoreSum, 3n, 80n).pass) return "Proven";
  return null;
}

/** Average score with up to two decimals ("93.33"), or "-" when there are no paid jobs. */
export function average(jobs: bigint, scoreSum: bigint): string {
  return jobs ? `${Number((scoreSum * 100n) / jobs) / 100}` : "-";
}

export type GateLine = { label: string; value: string; need: string; ok: boolean };
/** Human-readable rows for a gate check: what the identity has and what the gate needs. */
export function describeGate(check: GateCheck): GateLine[] {
  const lines: GateLine[] = [
    { label: "Paid jobs", value: String(check.jobs), need: `${check.minJobs}+`, ok: check.jobsOk },
  ];
  if (check.minAvg > 0n)
    lines.push({
      label: "Score sum",
      value: String(check.scoreSum),
      need:
        check.jobs === 0n
          ? "an average needs at least one paid job"
          : `${check.requiredSum}+ (${check.minAvg} x ${check.jobs} jobs)`,
      ok: check.scoreOk && check.jobs > 0n,
    });
  return lines;
}

// ---- deep links ---------------------------------------------------------------------------------------------

export type ProfileTarget = { kind: "agent"; agentId: bigint } | { kind: "wallet"; wallet: Address };

/** A wallet address as typed or pasted, or null. Mixed-case input must carry a valid checksum. */
export function normalizeWallet(input: string): Address | null {
  const text = input.trim();
  return isAddress(text) ? (text as Address) : null;
}

/**
 * ?agent=<id> and ?wallet=<0x..> from a query string ("?agent=1", "agent=1" or a full URL's search part).
 * A non-zero agent wins over a wallet; agent=0 or garbage falls through to the wallet, then to null.
 */
export function parseProfileQuery(search: string): ProfileTarget | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const agent = (params.get("agent") ?? "").trim();
  if (/^\d{1,30}$/.test(agent) && BigInt(agent) > 0n) return { kind: "agent", agentId: BigInt(agent) };
  const wallet = normalizeWallet(params.get("wallet") ?? "");
  return wallet ? { kind: "wallet", wallet } : null;
}

export function profileQuery(target: ProfileTarget): string {
  return target.kind === "agent" ? `agent=${target.agentId}` : `wallet=${target.wallet}`;
}
export function profilePath(target: ProfileTarget): string {
  return `/profile?${profileQuery(target)}`;
}

export type ProfileExample = { id: string; title: string; note: string; detail?: string; target: ProfileTarget };
export const PROFILE_EXAMPLES: readonly ProfileExample[] = [
  {
    id: "agent-10388",
    title: "Agent #10388",
    note: "Monad demo, paid on mainnet",
    target: { kind: "agent", agentId: 10388n },
  },
  {
    id: "arc-worker",
    title: "Arc worker",
    note: "6 paid jobs mirrored from Arc",
    detail: "0x092F4483526eBc2476c247cB88d166aDb7C3232f",
    target: { kind: "wallet", wallet: "0x092F4483526eBc2476c247cB88d166aDb7C3232f" },
  },
];

export const postersLine = (count: bigint): string => `Paid by ${count} different poster${count === 1n ? "" : "s"}`;
