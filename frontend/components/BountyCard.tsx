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
  isTaken: boolean;
  inDispute: boolean;
  resolved: boolean;
  disputeInitiator: string;
  disputeRaisedAt: bigint;
  disputeReasonHash: string;
  disputeResponseHash: string;
  disputeRulingHash: string;
};

const CATEGORY_COLORS: Record<string, string> = {
  dev:     "bg-blue-900/50 text-blue-300 border-blue-800",
  design:  "bg-purple-900/50 text-purple-300 border-purple-800",
  content: "bg-green-900/50 text-green-300 border-green-800",
  data:    "bg-yellow-900/50 text-yellow-300 border-yellow-800",
  other:   "bg-gray-800 text-gray-300 border-gray-700",
};

function statusLabel(meta: BountyMeta): { text: string; color: string } {
  if (meta.assignedProvider !== "0x0000000000000000000000000000000000000000") {
    if (meta.submittedResultHash) return { text: "Submitted", color: "text-yellow-400" };
    return { text: "Assigned", color: "text-blue-400" };
  }
  const { expired } = secondsToDeadline(meta.deadline);
  if (expired) return { text: "Expired", color: "text-red-400" };
  return { text: "Open", color: "text-green-400" };
}

export function BountyCard({ meta }: { meta: BountyMeta }) {
  const { label, expired } = secondsToDeadline(meta.deadline);
  const catClass = CATEGORY_COLORS[meta.category] ?? CATEGORY_COLORS.other;
  const status = statusLabel(meta);

  return (
    <Link href={`/bounty/${meta.jobId}`}>
      <div className="glass glass-hover rounded-2xl p-5 transition-all cursor-pointer group">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {/* Category + Agent-only badge */}
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${catClass}`}>
                {meta.category}
              </span>
              {meta.agentOnly && (
                <span className="text-xs px-2 py-0.5 rounded-full border border-violet-700 bg-violet-900/50 text-violet-300 font-medium">
                  Agent only
                </span>
              )}
              {meta.humanOnly && (
                <span className="text-xs px-2 py-0.5 rounded-full border border-orange-700 bg-orange-900/40 text-orange-300 font-medium">
                  Human only
                </span>
              )}
              {meta.inDispute && (
                <span className="text-xs px-2 py-0.5 rounded-full border border-red-700 bg-red-900/40 text-red-300 font-medium">
                  In dispute
                </span>
              )}
              <span className={`text-xs font-medium ${status.color}`}>{status.text}</span>
            </div>

            {/* Tags */}
            {meta.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {meta.tags.map((tag) => (
                  <span key={tag} className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {/* IPFS hash as subtitle until full description loads */}
            <p className="text-xs text-gray-500 font-mono truncate">{meta.ipfsDescHash}</p>
          </div>

          {/* Reward + deadline */}
          <div className="text-right shrink-0">
            <div className="text-xl font-bold text-green-400">${formatUsdc(meta.reward)}</div>
            <div className={`text-xs mt-1 ${expired ? "text-red-400" : "text-gray-500"}`}>
              {label}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
