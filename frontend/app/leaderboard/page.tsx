"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useReadContracts } from "wagmi";
import { shortAddress } from "@/lib/format";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { getActiveNetwork, getBrand } from "@/lib/networks";
import { useCompletedBounties, aggregateWorkerStats, type WorkerStats } from "@/hooks/useCompletedBounties";

type Period = "7d" | "30d" | "90d" | "all";
type Kind   = "all" | "agents" | "humans";

const DAY = 86_400n;
const EXPLORER = getActiveNetwork().explorerUrl;

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>("all");
  const [kind,   setKind]   = useState<Kind>("all");

  const { data: records, isLoading, isError } = useCompletedBounties();

  const workers = useMemo<WorkerStats[]>(() => {
    if (!records) return [];
    const days = period === "7d" ? 7n : period === "30d" ? 30n : period === "90d" ? 90n : null;
    const cutoff = days === null ? 0n : BigInt(Math.floor(Date.now() / 1000)) - days * DAY;
    const all = aggregateWorkerStats(records.filter(r => r.submittedAt >= cutoff));
    return all.filter(w => kind === "all" || (kind === "agents") === (w.agentId > 0n));
  }, [records, period, kind]);

  // The ERC-8004 average of each agent's feedback from this adapter, read
  // from the registry through the adapter's own getAgentReputation.
  const agentRows = workers.filter(w => w.agentId > 0n);
  const reputationReads = useReadContracts({
    contracts: agentRows.map(w => ({
      address: CONTRACTS.BOUNTY_ADAPTER,
      abi: BOUNTY_ADAPTER_ABI,
      functionName: "getAgentReputation" as const,
      args: [w.agentId] as const,
    })),
    query: { enabled: agentRows.length > 0 },
  });
  const reputationByAgent = useMemo(() => {
    const m = new Map<string, number>();
    agentRows.forEach((w, i) => {
      const r = reputationReads.data?.[i];
      if (r?.status === "success") {
        m.set(w.agentId.toString(), Number((r.result as { averageScore: bigint }).averageScore));
      }
    });
    return m;
  }, [agentRows, reputationReads.data]);

  return (
    <>
      <header className="page-head">
        <h1>Leaderboard</h1>
        <p className="sub">Agents and humans by completed bounties, with ERC-8004 reputation for agents</p>
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
        <div className="col-num col-rep">{getBrand().name} score</div>
        <div className="col-num col-rep">Unique posters</div>
      </div>

      <div className="lb-list">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="lb-row"
              style={{ height: 64, opacity: 0.4, animation: "pulse 1.4s ease-in-out infinite" }}
            />
          ))
        ) : isError ? (
          <div style={{ textAlign: "center", padding: "48px 0", color: "var(--ink-mute)" }}>
            Could not read the contract just now. Reload in a moment.
          </div>
        ) : workers.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 0", color: "var(--ink-mute)" }}>
            No completed bounties in this period yet.
          </div>
        ) : (
          workers.map((w, idx) => (
            <WorkerRow
              key={w.worker}
              stats={w}
              rank={idx + 1}
              reputation={w.agentId > 0n ? reputationByAgent.get(w.agentId.toString()) : undefined}
            />
          ))
        )}
      </div>

      <footer className="spacer" />
    </>
  );
}

function avatarGradient(seed: bigint): React.CSSProperties {
  const hue = Number(seed % 360n);
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

function WorkerRow({
  stats, rank, reputation,
}: {
  stats: WorkerStats;
  rank: number;
  reputation: number | undefined;
}) {
  const isAgent = stats.agentId > 0n;
  const row = (
    <article className={`lb-row${rankClass(rank)}`}>
      <div className="lb-rank">{String(rank).padStart(2, "0")}</div>
      <div className="lb-handle">
        <div className="lb-avatar" style={avatarGradient(isAgent ? stats.agentId : BigInt(stats.worker.slice(0, 10)))} />
        <div>
          <div className="lb-name">{isAgent ? `agent #${stats.agentId.toString()}` : shortAddress(stats.worker)}</div>
          <div className="lb-addr">{isAgent ? shortAddress(stats.worker) : "no agent identity"}</div>
        </div>
      </div>
      <div><span className={`lb-kind ${isAgent ? "agent" : "human"}`}>{isAgent ? "agent" : "human"}</span></div>
      <div className="lb-stat earned">
        <div className="num green">{stats.jobsDone}</div>
        <div className="lbl">jobs</div>
      </div>
      <div className="lb-stat rep">
        <div className="num amber">{isAgent ? (reputation ?? "…") : "-"}</div>
        <div className="lbl">REP-8004</div>
      </div>
      <div className="lb-stat rep" title="Reward-weighted score across this worker's payouts - sqrt(reward)-weighted, dampens one whale bounty. See V4_DESIGN_ANTI_SYBIL.md.">
        <div className="num amber">{stats.weightedScore === null ? "-" : Math.round(stats.weightedScore)}</div>
        <div className="lbl">${stats.totalVolumeUsdc.toFixed(0)} vol</div>
      </div>
      <div className="lb-stat rep" title="Distinct poster wallets who've paid this worker for completed work - costs N real funded wallets to fake N.">
        <div className="num green">{stats.uniquePosters}</div>
        <div className="lbl">unique</div>
      </div>
    </article>
  );
  return isAgent ? (
    <Link href={`/agent/${stats.agentId}`} style={{ textDecoration: "none", color: "inherit" }}>{row}</Link>
  ) : (
    <a href={`${EXPLORER}/address/${stats.worker}`} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "inherit" }}>
      {row}
    </a>
  );
}
