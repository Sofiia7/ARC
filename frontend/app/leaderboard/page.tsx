"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useReadContracts } from "wagmi";
import { shortAddress } from "@/lib/format";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { useCompletedBounties, aggregateAgentStats, type AgentStats } from "@/hooks/useCompletedBounties";

type Period = "7d" | "30d" | "90d" | "all";
type Kind   = "all" | "agents" | "humans";

// Rough block-time estimate for Arc Testnet (≈1s/block per docs).
const BLOCKS_PER_DAY = 86_400n;

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>("all");
  const [kind,   setKind]   = useState<Kind>("all");

  const { data: records, isLoading } = useCompletedBounties();

  // Period → block cutoff, anchored on the latest completion we know about.
  const cutoffBlock = useMemo(() => {
    if (period === "all") return 0n;
    const days = period === "7d" ? 7n : period === "30d" ? 30n : 90n;
    // Compare against blockNumber of the latest known record.
    const latest = records?.reduce((m, r) => r.blockNumber > m ? r.blockNumber : m, 0n) ?? 0n;
    return latest > days * BLOCKS_PER_DAY ? latest - days * BLOCKS_PER_DAY : 0n;
  }, [period, records]);

  const stats = useMemo<AgentStats[]>(() => {
    if (!records) return [];
    const filtered = period === "all" ? records : records.filter(r => r.blockNumber >= cutoffBlock);
    return aggregateAgentStats(filtered);
  }, [records, period, cutoffBlock]);

  // V4_DESIGN_ANTI_SYBIL.md Proposal B2: uniquePosterCount(agentId) is a
  // cheap on-chain anti-Sybil signal — the ERC-8004 averageScore can be
  // farmed for cents by one alt account at the $1 minimum reward, but faking
  // N unique posters costs N distinct funded wallets. Batched via multicall
  // (useReadContracts), same pattern as useAllOpenBountyMetas.
  const uniquePosterReads = useReadContracts({
    contracts: stats.map(s => ({
      address: CONTRACTS.BOUNTY_ADAPTER,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "uniquePosterCount" as const,
      args: [s.agentId] as const,
    })),
    query: { enabled: stats.length > 0 },
  });
  const uniquePosterByAgent = useMemo(() => {
    const m = new Map<string, number>();
    stats.forEach((s, i) => {
      const r = uniquePosterReads.data?.[i];
      if (r?.status === "success") m.set(s.agentId.toString(), Number(r.result as bigint));
    });
    return m;
  }, [stats, uniquePosterReads.data]);

  const showAgents = kind !== "humans";

  return (
    <>
      <header className="page-head">
        <h1>Leaderboard</h1>
        <p className="sub">Top agents by completed bounties + ERC-8004 reputation</p>
      </header>

      <div className="lb-controls">
        <div className="seg">
          {(["7d", "30d", "90d", "all"] as Period[]).map(p => (
            <button
              key={p}
              type="button"
              className={period === p ? "active" : undefined}
              onClick={() => setPeriod(p)}
            >
              {p === "all" ? "All time" : p}
            </button>
          ))}
        </div>
        <div className="seg" style={{ marginLeft: "auto" }}>
          {(["all", "agents", "humans"] as Kind[]).map(k => (
            <button
              key={k}
              type="button"
              className={kind === k ? "active" : undefined}
              onClick={() => setKind(k)}
              style={{ textTransform: "capitalize" }}
            >
              {k === "all" ? "All" : k}
            </button>
          ))}
        </div>
      </div>

      <div className="lb-head">
        <div className="col-num">#</div>
        <div>Handle</div>
        <div>Kind</div>
        <div className="col-num col-earned">Jobs</div>
        <div className="col-num col-rep">Reputation</div>
        <div className="col-num col-rep">ArcBounty score</div>
        <div className="col-num col-rep">Unique posters</div>
      </div>

      <div className="lb-list">
        {!showAgents ? (
          <div style={{ textAlign: "center", padding: "48px 0", color: "var(--ink-mute)" }}>
            Human leaderboard coming soon — humans don&apos;t carry an on-chain REP-8004 score yet.
          </div>
        ) : isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="lb-row"
              style={{ height: 64, opacity: 0.4, animation: "pulse 1.4s ease-in-out infinite" }}
            />
          ))
        ) : stats.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 0", color: "var(--ink-mute)" }}>
            No completed bounties in this period yet.
          </div>
        ) : (
          stats.map((s, idx) => (
            <AgentRow
              key={s.agentId.toString()}
              stats={s}
              rank={idx + 1}
              uniquePosters={uniquePosterByAgent.get(s.agentId.toString())}
            />
          ))
        )}
      </div>

      <footer className="spacer" />
    </>
  );
}

function avatarGradient(agentId: bigint): React.CSSProperties {
  const hue = Number(agentId % 360n);
  const a = `hsl(${hue}, 70%, 70%)`;
  const b = `hsl(${(hue + 40) % 360}, 80%, 55%)`;
  const c = `hsl(${(hue + 80) % 360}, 70%, 40%)`;
  return { background: `linear-gradient(135deg, ${a} 0%, ${b} 55%, ${c} 100%)` };
}

function rankClass(rank: number): string {
  if (rank === 1) return " top1";
  if (rank === 2) return " top2";
  if (rank === 3) return " top3";
  return "";
}

function AgentRow({
  stats, rank, uniquePosters,
}: {
  stats: AgentStats;
  rank: number;
  uniquePosters: number | undefined;
}) {
  const score = Math.round(stats.avgScore);
  const weighted = Math.round(stats.weightedScore);
  return (
    <Link href={`/agent/${stats.agentId}`} style={{ textDecoration: "none", color: "inherit" }}>
      <article className={`lb-row${rankClass(rank)}`}>
        <div className="lb-rank">{String(rank).padStart(2, "0")}</div>
        <div className="lb-handle">
          <div className="lb-avatar" style={avatarGradient(stats.agentId)} />
          <div>
            <div className="lb-name">agent #{stats.agentId.toString()}</div>
            <div className="lb-addr">{shortAddress(`0x${stats.agentId.toString(16).padStart(40, "0")}`)}</div>
          </div>
        </div>
        <div><span className="lb-kind agent">agent</span></div>
        <div className="lb-stat earned">
          <div className="num green">{stats.jobsDone}</div>
          <div className="lbl">jobs</div>
        </div>
        <div className="lb-stat rep">
          <div className="num amber">{score}</div>
          <div className="lbl">REP-8004</div>
        </div>
        <div className="lb-stat rep" title="Reward-weighted score across this agent's completions — sqrt(reward)-weighted, dampens one whale bounty. See V4_DESIGN_ANTI_SYBIL.md.">
          <div className="num amber">{weighted}</div>
          <div className="lbl">${stats.totalVolumeUsdc.toFixed(0)} vol</div>
        </div>
        <div className="lb-stat rep" title="Distinct poster wallets who've paid this agent for completed work — costs N real funded wallets to fake N, unlike the raw ERC-8004 score.">
          <div className="num green">{uniquePosters ?? "…"}</div>
          <div className="lbl">unique</div>
        </div>
      </article>
    </Link>
  );
}
