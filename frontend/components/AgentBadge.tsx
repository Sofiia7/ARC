"use client";

import { useAgentReputations, useAgentWork } from "@/hooks/useAgentReputations";

type Props = {
  agentId: bigint;
  compact?: boolean;
};

function scoreClass(score: number | null): string {
  if (score === null) return "";
  if (score >= 90) return "good";
  if (score >= 70) return "ok";
  return "bad";
}

export function AgentBadge({ agentId, compact = false }: Props) {
  // Score from every adapter this network ran; jobs and unique posters counted
  // the leaderboard's way, so the badge and the agent's leaderboard row agree.
  // Unique posters stay the anti-Sybil signal of V4_DESIGN_ANTI_SYBIL.md B1/B2:
  // N of them cost N real funded wallets to fake.
  const { byAgent, isError } = useAgentReputations(agentId > 0n ? [agentId] : []);
  const work = useAgentWork(agentId, { enabled: !compact });
  const rep = byAgent.get(agentId.toString());
  const repError = isError && !rep;

  if (agentId === 0n) return null;

  const score = rep ? rep.averageScore : null;
  const loaded = !work.isLoading;
  const jobs   = work.row ? work.row.jobsDone : loaded ? 0 : null;
  const unique = work.row ? work.row.uniquePosters : loaded ? 0 : null;

  if (compact) {
    return (
      <span className="agent-badge compact">
        <span className="glyph" />
        <span className="title">Agent #{agentId.toString()}</span>
        {score !== null && (
          <span className={`score ${scoreClass(score)}`} style={{ marginLeft: 4 }}>
            {score}
          </span>
        )}
      </span>
    );
  }

  return (
    <div className="agent-badge">
      <span className="glyph" />
      <div>
        <div className="title">ERC-8004 Agent #{agentId.toString()}</div>
        <div className="meta">
          {score !== null ? (
            <>
              <span>
                Score: <span className={`score ${scoreClass(score)}`}>{score}/100</span>
              </span>
              <span className="dot-sep">·</span>
              <span style={{ color: "var(--ink-mute)" }}>{jobs ?? "…"} jobs completed</span>
              {unique !== null && (
                <>
                  <span className="dot-sep">·</span>
                  <span
                    style={{ color: "var(--ink-mute)" }}
                    title="Distinct poster wallets who've paid this agent for completed work - an anti-Sybil signal that costs N real funded wallets to fake N. See V4_DESIGN_ANTI_SYBIL.md."
                  >
                    {unique} unique poster{unique === 1 ? "" : "s"}
                  </span>
                </>
              )}
            </>
          ) : repError ? (
            <span style={{ color: "var(--ink-mute)" }}>Reputation registry unavailable</span>
          ) : (
            <span style={{ color: "var(--ink-mute)" }}>Loading reputation…</span>
          )}
        </div>
      </div>
    </div>
  );
}
