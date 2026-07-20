import type { BountyMeta } from "arcbounty-agent-sdk";

const USDC_DECIMALS = 6;

export function formatUsdc(atomic: bigint): string {
  const sign = atomic < 0n ? "-" : "";
  const abs = atomic < 0n ? -atomic : atomic;
  const whole = abs / 10n ** BigInt(USDC_DECIMALS);
  const frac = (abs % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0");
  return `${sign}${whole}.${frac.slice(0, 2)}`;
}

export type BountyStatus =
  | "open"
  | "expired"
  | "in_progress"
  | "submitted"
  | "rejection_pending"
  | "in_dispute"
  | "resolved";

/** Escrow state, derived exactly from the adapter's own flags — one field an
 * agent can branch on instead of re-deriving the state machine client-side. */
export function deriveStatus(m: BountyMeta, nowSec: number = Math.floor(Date.now() / 1000)): BountyStatus {
  if (m.resolved) return "resolved";
  if (m.inDispute) return "in_dispute";
  if (m.rejectedAt > 0n) return "rejection_pending";
  if (m.submittedResultHash.length > 0) return "submitted";
  if (m.isTaken) return "in_progress";
  return Number(m.deadline) < nowSec ? "expired" : "open";
}

function tsToIso(unixSec: bigint): string | null {
  return unixSec > 0n ? new Date(Number(unixSec) * 1000).toISOString() : null;
}

/** Public JSON shape. BigInt-free (JSON.stringify chokes on BigInt), atomic
 * amounts as strings, timestamps doubled as unix + ISO for agent convenience. */
export function serializeBounty(m: BountyMeta) {
  return {
    jobId: m.jobId.toString(),
    status: deriveStatus(m),
    poster: m.poster,
    reward: { atomic: m.reward.toString(), usdc: formatUsdc(m.reward) },
    deadline: { unix: Number(m.deadline), iso: tsToIso(m.deadline) },
    descriptionCid: m.ipfsDescHash,
    category: m.category,
    tags: m.tags,
    agentOnly: m.agentOnly,
    humanOnly: m.humanOnly,
    whitelistedProvider: m.whitelistedProvider,
    requireWorkerBond: m.requireWorkerBond,
    workerBond: m.requireWorkerBond
      ? { atomic: m.workerBond.toString(), usdc: formatUsdc(m.workerBond) }
      : null,
    assignedProvider: m.assignedProvider,
    assignedAgentId: m.agentId > 0n ? m.agentId.toString() : null,
    submittedAt: { unix: Number(m.submittedAt), iso: tsToIso(m.submittedAt) },
    inDispute: m.inDispute,
    resolved: m.resolved,
  };
}

/** Submission info for /v1/bounties/:id/submissions — the adapter stores at
 * most one submission per bounty, so this is an array of 0 or 1 entries. */
export function serializeSubmissions(m: BountyMeta) {
  if (m.submittedResultHash.length === 0) return [];
  return [
    {
      provider: m.assignedProvider,
      agentId: m.agentId > 0n ? m.agentId.toString() : null,
      resultCid: m.submittedResultHash,
      submittedAt: { unix: Number(m.submittedAt), iso: tsToIso(m.submittedAt) },
      rejected: m.rejectedAt > 0n,
      rejectionReasonCid: m.rejectionReasonHash.length > 0 ? m.rejectionReasonHash : null,
    },
  ];
}
