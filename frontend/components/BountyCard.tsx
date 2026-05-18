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
  assignedProvider: string;
  submittedResultHash: string;
  submittedAt: bigint;
  funded: boolean;
  inDispute: boolean;
  isTaken: boolean;
  finalized: boolean;
  commitRevealRequired: boolean;
  whitelistedProvider: string;
};

const CATEGORY_COLORS: Record<string, string> = {
  dev:     "from-blue-500/15 to-cyan-500/15 text-blue-200 border-blue-400/30",
  design:  "from-purple-500/15 to-pink-500/15 text-purple-200 border-purple-400/30",
  content: "from-green-500/15 to-emerald-500/15 text-green-200 border-green-400/30",
  data:    "from-yellow-500/15 to-orange-500/15 text-yellow-200 border-yellow-400/30",
  other:   "from-gray-500/15 to-slate-500/15 text-gray-200 border-gray-400/30",
};

function statusLabel(meta: BountyMeta): { text: string; color: string; dot: string } {
  if (meta.finalized)          return { text: "Finalized", color: "text-gray-400",   dot: "bg-gray-400" };
  if (meta.inDispute)          return { text: "Disputed",  color: "text-red-300",    dot: "bg-red-400" };
  if (meta.submittedResultHash) return { text: "Submitted", color: "text-amber-300",  dot: "bg-amber-400" };
  if (meta.isTaken)            return { text: "Assigned",  color: "text-blue-300",   dot: "bg-blue-400" };
  const { expired } = secondsToDeadline(meta.deadline);
  if (expired) return { text: "Expired", color: "text-red-400", dot: "bg-red-500" };
  return { text: "Open", color: "text-emerald-300", dot: "bg-emerald-400" };
}

export function BountyCard({ meta }: { meta: BountyMeta }) {
  const { label, expired } = secondsToDeadline(meta.deadline);
  const catClass = CATEGORY_COLORS[meta.category] ?? CATEGORY_COLORS.other;
  const status = statusLabel(meta);

  return (
    <Link href={`/bounty/${meta.jobId}`}>
      <div className="glass glass-hover p-5 cursor-pointer">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {/* Pills */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className={`pill bg-gradient-to-r ${catClass} capitalize`}>
                {meta.category}
              </span>
              {meta.agentOnly && (
                <span className="pill text-violet-200 border-violet-400/30 bg-violet-500/10">
                  Agent only
                </span>
              )}
              {meta.commitRevealRequired && (
                <span className="pill text-amber-200 border-amber-400/30 bg-amber-500/10">
                  MEV-protected
                </span>
              )}
              <span className={`pill ${status.color}`}>
                <span className={`pulse-dot ${status.dot}`} />
                {status.text}
              </span>
            </div>

            {/* Tags */}
            {meta.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {meta.tags.map((tag) => (
                  <span key={tag} className="text-xs text-gray-400 bg-white/5 px-2 py-0.5 rounded border border-white/5">
                    {tag}
                  </span>
                ))}
              </div>
            )}

            <p className="text-xs text-gray-500 font-mono truncate">{meta.ipfsDescHash}</p>
          </div>

          {/* Reward + deadline */}
          <div className="text-right shrink-0">
            <div className="text-2xl font-bold text-gradient">${formatUsdc(meta.reward)}</div>
            <div className={`text-xs mt-1 ${expired ? "text-red-400" : "text-gray-500"}`}>
              {label}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
