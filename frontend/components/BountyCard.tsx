import Link from "next/link";
import { formatUsdc, secondsToDeadline } from "@/lib/format";

export type BountyMeta = {
  jobId: bigint;
  poster: string;
  reward: bigint;
  deadline: bigint;
  ipfsDescHash: string;
  category: string;
  tags: readonly string[];
  agentId: bigint;
  agentOnly: boolean;
  humanOnly: boolean;
  whitelistedProvider: string;
  assignedProvider: string;
  submittedResultHash: string;
  submittedAt: bigint;
  isTaken: boolean;
  rejectedAt: bigint;
  rejectionReasonHash: string;
  inDispute: boolean;
  resolved: boolean;
  disputeInitiator: string;
  disputeRaisedAt: bigint;
  disputeReasonHash: string;
  disputeResponseHash: string;
  disputeRulingHash: string;
};

type Status = "open" | "submitted" | "in-review" | "paid" | "expired";

function statusFor(meta: BountyMeta): { kind: Status; label: string } {
  const { expired } = secondsToDeadline(meta.deadline);
  if (meta.resolved && !meta.inDispute && meta.submittedResultHash) {
    return { kind: "paid", label: "Paid" };
  }
  if (meta.inDispute) {
    return { kind: "in-review", label: "In Dispute" };
  }
  if (meta.submittedResultHash) {
    return { kind: "submitted", label: "Submitted" };
  }
  if (meta.isTaken) {
    return { kind: "in-review", label: "In Progress" };
  }
  if (expired) return { kind: "expired", label: "Expired" };
  return { kind: "open", label: "Open" };
}

const KNOWN_CATS = new Set(["dev", "design", "content", "data", "other"]);

export function BountyCard({ meta }: { meta: BountyMeta }) {
  const { label: timeLabel } = secondsToDeadline(meta.deadline);
  const catClass = KNOWN_CATS.has(meta.category) ? `cat-${meta.category}` : "cat-other";
  const status = statusFor(meta);

  return (
    <Link href={`/bounty/${meta.jobId}`} style={{ textDecoration: "none", color: "inherit" }}>
      <article className="row">
        <div>
          <div className="top-line">
            <span className={`tag ${catClass}`}>{meta.category}</span>
            {meta.agentOnly && <span className="tag agent-only">Agent only</span>}
            {meta.humanOnly && <span className="tag human-only">Human only</span>}
            <span className={`status ${status.kind}`}>{status.label}</span>
          </div>

          {meta.tags.length > 0 && (
            <div className="subtags">
              {meta.tags.map(tag => (
                <span key={tag} className="subtag">{tag}</span>
              ))}
            </div>
          )}

          <div className="hash">{meta.ipfsDescHash}</div>
        </div>

        <div className="right">
          <div className="price">${formatUsdc(meta.reward)}</div>
          <div className="time">{timeLabel}</div>
        </div>
      </article>
    </Link>
  );
}
