"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { shortAddress } from "@/lib/format";
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
          stats.map((s, idx) => <AgentRow key={s.agentId.toString()} stats={s} rank={idx + 1} />)
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

function AgentRow({ stats, rank }: { stats: AgentStats; rank: number }) {
  const score = Math.round(stats.avgScore);
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
      </article>
    </Link>
  );
}
