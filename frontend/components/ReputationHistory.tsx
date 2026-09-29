"use client";

import { useAgentReputations, useAgentWork } from "@/hooks/useAgentReputations";

type Props = { agentId: bigint };

export function ReputationHistory({ agentId }: Props) {
  // Same sources as AgentBadge: every adapter's reputation, and jobs counted
  // the leaderboard's way.
  const { byAgent, isLoading } = useAgentReputations([agentId]);
  const work = useAgentWork(agentId);
  const rep = byAgent.get(agentId.toString());

  if (isLoading) {
    return <div className="row" style={{ height: 96, opacity: 0.5 }} />;
  }
  if (!rep) return null;

  const score     = rep.averageScore;
  const jobs      = work.row ? work.row.jobsDone : work.isLoading ? "…" : 0;
  const feedbacks = rep.totalFeedbacks;

  const barColor =
    score >= 90 ? "var(--green)"
    : score >= 70 ? "var(--yellow)"
    : "var(--rose)";

  return (
    <div
      style={{
        padding: "16px 18px",
        borderRadius: 14,
        background: "var(--g-bg)",
        border: "1px solid var(--g-border)",
        backdropFilter: "var(--g-blur)",
        WebkitBackdropFilter: "var(--g-blur)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <h3
        style={{
          margin: 0,
          fontFamily: 'var(--font-jetbrains-mono), monospace',
          fontSize: 11,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "var(--ink-mute)",
        }}
      >
        On-chain Reputation (ERC-8004)
      </h3>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.08)",
            borderRadius: 999,
            height: 8,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: 8,
              borderRadius: 999,
              width: `${score}%`,
              background: barColor,
              transition: "width 240ms ease",
              boxShadow: `0 0 12px ${barColor}66`,
            }}
          />
        </div>
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "var(--ink)",
            minWidth: 56,
            textAlign: "right",
            fontFeatureSettings: '"tnum"',
          }}
        >
          {score}/100
        </span>
      </div>

      <div style={{ display: "flex", gap: 24, fontSize: 13, color: "var(--ink-soft)" }}>
        <span>
          <span style={{ color: "var(--ink)", fontWeight: 700 }}>{jobs}</span> jobs completed
        </span>
        <span>
          <span style={{ color: "var(--ink)", fontWeight: 700 }}>{feedbacks}</span> feedbacks
        </span>
      </div>
    </div>
  );
}
