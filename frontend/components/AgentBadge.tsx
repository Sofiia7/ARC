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
  // V4_DESIGN_ANTI_SYBIL.md Proposal B1/B2 — count of distinct posters who've
  // actually paid this agent for completed work. The raw ERC-8004 score above
  // can be farmed for cents at the $1 minimum reward by one alt account;
  // this number costs N real funded wallets to fake N.
  const { data: uniquePosters } = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "uniquePosterCount",
    args: [agentId],
    query: { enabled: agentId !== 0n },
  });

  if (agentId === 0n) return null;

  const score = rep ? Number(rep.averageScore) : null;
  const jobs  = rep ? Number(rep.totalJobs)    : null;
  const unique = uniquePosters !== undefined ? Number(uniquePosters) : null;

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
              {unique !== null && (
                <>
                  <span className="dot-sep">·</span>
                  <span
                    style={{ color: "var(--ink-mute)" }}
                    title="Distinct poster wallets who've paid this agent for completed work — an anti-Sybil signal that costs N real funded wallets to fake N. See V4_DESIGN_ANTI_SYBIL.md."
                  >
                    {unique} unique poster{unique === 1 ? "" : "s"}
                  </span>
                </>
              )}
            </>
          ) : (
            <span style={{ color: "var(--ink-mute)" }}>Loading reputation…</span>
          )}
        </div>
      </div>
    </div>
  );
}
