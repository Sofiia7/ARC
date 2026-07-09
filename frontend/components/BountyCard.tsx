import Link from "next/link";
import { useEffect, useState } from "react";
import { formatUsdc, secondsToDeadline } from "@/lib/format";
import { fetchIpfsText } from "@/lib/ipfs";

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
  requireWorkerBond: boolean;
  workerBond: bigint;
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

// Module-level cache so scrolling a card out of view and back doesn't
// re-fetch, and every list (Browse, My Tasks, category pages) shares hits.
// `null` marks a fetch that failed — falls back to showing the raw hash.
const titleCache = new Map<string, string | null>();

function extractTitle(markdown: string): string {
  const firstLine = markdown.split("\n").map(l => l.trim()).find(l => l.length > 0) ?? "";
  const stripped = firstLine.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
  return stripped.length > 100 ? `${stripped.slice(0, 100)}…` : stripped;
}

function BountyTitle({ cid }: { cid: string }) {
  const [title, setTitle] = useState<string | null | undefined>(() => titleCache.get(cid));

  useEffect(() => {
    if (titleCache.has(cid)) { setTitle(titleCache.get(cid)); return; }
    let cancelled = false;
    fetchIpfsText(cid)
      .then(text => {
        const extracted = extractTitle(text) || null;
        titleCache.set(cid, extracted);
        if (!cancelled) setTitle(extracted);
      })
      .catch(() => {
        titleCache.set(cid, null);
        if (!cancelled) setTitle(null);
      });
    return () => { cancelled = true; };
  }, [cid]);

  if (title === undefined) return <div className="bounty-title skeleton" />;
  if (title === null) return <div className="hash">{cid}</div>;
  return <div className="bounty-title">{title}</div>;
}

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
            {meta.requireWorkerBond && <span className="tag bond-required">Bond required</span>}
            <span className={`status ${status.kind}`}>{status.label}</span>
          </div>

          <BountyTitle cid={meta.ipfsDescHash} />

          {meta.tags.length > 0 && (
            <div className="subtags">
              {meta.tags.map(tag => (
                <span key={tag} className="subtag">{tag}</span>
              ))}
            </div>
          )}
        </div>

        <div className="right">
          <div className="price">${formatUsdc(meta.reward)}</div>
          <div className="time">{timeLabel}</div>
        </div>
      </article>
    </Link>
  );
}
