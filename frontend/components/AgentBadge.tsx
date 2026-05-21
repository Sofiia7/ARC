"use client";

import { useReadContract } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";

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
  const { data: rep } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "getAgentReputation",
    args: [agentId],
  });

  if (agentId === 0n) return null;

  const score = rep ? Number(rep.averageScore) : null;
  const jobs  = rep ? Number(rep.totalJobs)    : null;

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
              <span style={{ color: "var(--ink-mute)" }}>{jobs} jobs completed</span>
            </>
          ) : (
            <span style={{ color: "var(--ink-mute)" }}>Loading reputation…</span>
          )}
        </div>
      </div>
    </div>
  );
}
