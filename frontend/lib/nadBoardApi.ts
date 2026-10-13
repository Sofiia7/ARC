// Client side of GET /api/nad/stats (block-pinned counters, leaderboard, recent payouts). React-free.
//
// Wire format (app/api/nad/stats/route.ts, lib/nadStats.ts): counters and ids are JSON numbers (a bigint-like total
// may arrive as a decimal string), USDC amounts are decimal strings in whole USDC such as "2.97". The parser below
// accepts either spelling for counters, normalises everything to strings, and turns a field the server did not send
// into null instead of a made-up zero.

export const NAD_STATS_PATH = "/api/nad/stats";
export const NAD_COUNT_KEYS = [
  "posted",
  "open",
  "inProgress",
  "settledPaid",
  "refunded",
  "expired",
  "uniquePosters",
  "uniquePaidIdentities",
] as const;
export const NAD_USDC_KEYS = ["paidOutUsdc", "feesUsdc"] as const;
export type NadStatKey = (typeof NAD_COUNT_KEYS)[number] | (typeof NAD_USDC_KEYS)[number];

export type NadLeaderRow = { owner: string; agentId: string; paidJobs: string; usdcEarned: string };
export type NadRecentRow = {
  jobId: string;
  /** "single" or "contest". */
  kind: string;
  reward: string;
  netPaid: string;
  ownerPaid: string;
  agentId: string;
};
export type NadStatsCoverage = { jobsRead: string | null; totalBounties: string | null; truncated: boolean };
export type NadStatsData = {
  chainId: number | null;
  adapter: string;
  sourceBlock: string;
  sourceBlockHash: string;
  generatedAt: string;
  coverage: NadStatsCoverage | null;
  stats: Record<NadStatKey, string | null>;
  leaderboard: NadLeaderRow[];
  recentlySettled: NadRecentRow[];
};

/** A non-negative integer as a decimal string, from a string, number or bigint. Anything else is null. */
export function toDecimal(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === "string" && /^\d{1,78}$/.test(value.trim())) return BigInt(value.trim()).toString();
  return null;
}

/** A whole-USDC amount with up to 6 decimals ("2.97", "1", 0.5) as a clean decimal string, else null. */
export function toUsdc(value: unknown): string | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    text = value.toFixed(6);
  } else if (typeof value === "string") text = value.trim();
  else return null;
  const m = /^(\d{1,60})(?:\.(\d{1,6}))?0*$/.exec(text);
  if (!m) return null;
  const whole = BigInt(m[1]).toString(),
    frac = (m[2] ?? "").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Defensive parse: returns null when the payload is not a stats response at all. */
export function parseNadStats(json: unknown): NadStatsData | null {
  const root = record(json);
  const rawStats = record(root?.stats);
  if (!root || !rawStats) return null;
  const stats = {} as Record<NadStatKey, string | null>;
  for (const key of NAD_COUNT_KEYS) stats[key] = toDecimal(rawStats[key]);
  for (const key of NAD_USDC_KEYS) stats[key] = toUsdc(rawStats[key]);
  const leaderboard: NadLeaderRow[] = [];
  if (Array.isArray(root.leaderboard))
    for (const item of root.leaderboard) {
      const r = record(item);
      const paidJobs = toDecimal(r?.paidJobs);
      if (!r || paidJobs === null) continue;
      leaderboard.push({
        owner: str(r.owner),
        agentId: toDecimal(r.agentId) ?? "0",
        paidJobs,
        usdcEarned: toUsdc(r.usdcEarned) ?? "0",
      });
    }
  const recentlySettled: NadRecentRow[] = [];
  if (Array.isArray(root.recentlySettled))
    for (const item of root.recentlySettled) {
      const r = record(item);
      const jobId = toDecimal(r?.jobId);
      if (!r || jobId === null) continue;
      recentlySettled.push({
        jobId,
        kind: str(r.kind),
        reward: toUsdc(r.reward) ?? "0",
        netPaid: toUsdc(r.netPaid) ?? "0",
        ownerPaid: str(r.ownerPaid),
        agentId: toDecimal(r.agentId) ?? "0",
      });
    }
  const cover = record(root.coverage);
  return {
    chainId: typeof root.chainId === "number" ? root.chainId : null,
    adapter: str(root.adapter),
    sourceBlock: toDecimal(root.sourceBlock) ?? "",
    sourceBlockHash: str(root.sourceBlockHash),
    generatedAt: str(root.generatedAt),
    coverage: cover
      ? {
          jobsRead: toDecimal(cover.jobsRead),
          totalBounties: toDecimal(cover.totalBounties),
          truncated: cover.truncated === true,
        }
      : null,
    stats,
    leaderboard,
    recentlySettled,
  };
}

/** Fetch and parse the stats. Rejects on timeout, a non-200 answer or an unreadable body. */
export async function fetchNadStats(
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; path?: string } = {},
): Promise<NadStatsData> {
  const { timeoutMs = 6000, fetchImpl = fetch, path = NAD_STATS_PATH } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(path, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Stats API answered ${response.status}`);
    const data = parseNadStats(await response.json());
    if (!data) throw new Error("Stats API returned an unexpected payload");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "$1,234.50" from a whole-USDC decimal string. Keeps up to six decimals when the amount has them and never fewer than
 * two, so no cent is rounded away.
 */
export function usdcFromDecimal(value: string | null | undefined): string {
  const clean = value === null || value === undefined ? null : toUsdc(value);
  if (clean === null) return "-";
  const [whole, frac = ""] = clean.split(".");
  return `$${BigInt(whole).toLocaleString("en-US")}.${frac.padEnd(2, "0")}`;
}

/** Link target for a leaderboard or payout row: the agent profile when there is an agent, else the wallet. */
export function profileHref(agentId: string, owner: string): string | null {
  if (agentId && agentId !== "0") return `/profile?agent=${agentId}`;
  return /^0x[0-9a-fA-F]{40}$/.test(owner) && !/^0x0{40}$/.test(owner) ? `/profile?wallet=${owner}` : null;
}
