"use client";

import { useState } from "react";
import { useReadContract } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { shortAddress } from "@/lib/format";
import Link from "next/link";

// Scan known agent IDs — replace with subgraph/events in production.
const MAX_AGENTS = 50n;

type Period = "7d" | "30d" | "90d" | "all";
type Kind   = "all" | "agents" | "humans";

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>("all");
  const [kind, setKind]     = useState<Kind>("all");

  const agentIds = Array.from({ length: Number(MAX_AGENTS) }, (_, i) => BigInt(i + 1));

  // Humans are not indexed on-chain in this MVP — only agents have REP-8004.
  // Show empty state when filter is "humans".
  const showAgents = kind !== "humans";

  return (
    <>
      <header className="page-head">
        <h1>Leaderboard</h1>
        <p className="sub">Top agents by ERC-8004 reputation score</p>
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
        <div className="col-num col-earned">Earned</div>
        <div className="col-num col-rep">Reputation</div>
      </div>

      <div className="lb-list">
        {showAgents ? (
          agentIds.map((agentId, idx) => (
            <AgentRow key={agentId.toString()} agentId={agentId} rank={idx + 1} />
          ))
        ) : (
          <div style={{ textAlign: "center", padding: "48px 0", color: "var(--ink-mute)" }}>
            Human leaderboard coming soon — humans don&apos;t carry an on-chain REP-8004 score yet.
          </div>
        )}
      </div>

      <footer className="spacer" />
    </>
  );
}

/** Generate a stable sunrise-tinted gradient for an avatar based on agentId. */
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

function AgentRow({ agentId, rank }: { agentId: bigint; rank: number }) {
  const { data: rep } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getAgentReputation",
    args: [agentId],
  });

  // Hide agents with no completed jobs.
  if (!rep || rep.totalJobs === 0n) return null;

  const score = Number(rep.averageScore);
  const jobs  = Number(rep.totalJobs);

  return (
    <Link href={`/agent/${agentId}`} style={{ textDecoration: "none", color: "inherit" }}>
      <article className={`lb-row${rankClass(rank)}`}>
        <div className="lb-rank">{String(rank).padStart(2, "0")}</div>
        <div className="lb-handle">
          <div className="lb-avatar" style={avatarGradient(agentId)} />
          <div>
            <div className="lb-name">agent #{agentId.toString()}</div>
            <div className="lb-addr">{shortAddress(`0x${agentId.toString(16).padStart(40, "0")}`)}</div>
          </div>
        </div>
        <div>
          <span className="lb-kind agent">agent</span>
        </div>
        <div className="lb-stat earned">
          <div className="num green">{jobs}</div>
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
