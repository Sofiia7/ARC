import type { Address } from "viem";
import type { BountyMeta, OpenBountiesFilter } from "./types.js";
import { USDC_DECIMALS } from "./constants.js";

// Pure logic extracted out of ArcBountyAgent so it's testable without a
// network client. Also de-duplicates what used to be two separate copies of
// the same filter logic (listOpenBounties + subscribeToNewBounties).

export function parseUsdc(dollars: number): bigint {
  return BigInt(Math.round(dollars * 10 ** USDC_DECIMALS));
}

/** `d` < 1e9 is interpreted as duration-in-seconds from `nowSec` (~30yr cutoff). */
export function resolveDeadline(d: number | Date, nowSec: number = Math.floor(Date.now() / 1000)): bigint {
  if (d instanceof Date) return BigInt(Math.floor(d.getTime() / 1000));
  if (d < 1_000_000_000) return BigInt(nowSec + d);
  return BigInt(d);
}

/**
 * V4 worker bond: max(minBond, reward * bondBps / 10_000). Mirrors
 * BountyAdapter._workerBondFor. Defaults are the live V4 parameters
 * (15% / $0.50 floor); pass the on-chain WORKER_BOND_BPS / MIN_WORKER_BOND
 * values to stay correct across redeploys with different parameters.
 */
export function workerBondFor(reward: bigint, bondBps: bigint = 1500n, minBond: bigint = 500_000n): bigint {
  const pct = (reward * bondBps) / 10_000n;
  return pct > minBond ? pct : minBond;
}

export function matchesBountyFilter(m: BountyMeta, f: OpenBountiesFilter): boolean {
  if (f.category && m.category !== f.category) return false;
  if (f.agentOnly === true && !m.agentOnly) return false;
  if (f.humanOnly === true && !m.humanOnly) return false;
  if (f.agentOnly === false && m.agentOnly) return false;
  if (f.humanOnly === false && m.humanOnly) return false;
  if (f.maxReward !== undefined && m.reward > parseUsdc(f.maxReward)) return false;
  if (f.minReward !== undefined && m.reward < parseUsdc(f.minReward)) return false;
  return true;
}

const TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x" + "0".repeat(64);

/** Pull the minted tokenId from a Transfer(from=0x0, to=self) log on `registryAddress`. */
export function agentIdFromReceiptLogs(
  logs: readonly { address: string; topics: readonly string[] }[],
  registryAddress: Address,
  selfAddress: Address,
): bigint | null {
  const me = selfAddress.toLowerCase().slice(2).padStart(64, "0");
  for (const log of logs) {
    if (log.address.toLowerCase() !== registryAddress.toLowerCase()) continue;
    if (log.topics.length < 4) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_SIG) continue;
    if (log.topics[1]?.toLowerCase() !== ZERO_TOPIC) continue; // from == 0x0
    if (log.topics[2]?.toLowerCase() !== "0x" + me) continue; // to == self
    return BigInt(log.topics[3]!); // tokenId
  }
  return null;
}
