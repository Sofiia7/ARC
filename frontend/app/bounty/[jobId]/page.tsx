"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import Link from "next/link";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { formatUsdc, shortAddress, secondsToDeadline } from "@/lib/format";
import { WorkSubmitModal } from "@/components/WorkSubmitModal";
import { DisputeOpenModal } from "@/components/DisputeOpenModal";
import { DisputePanel } from "@/components/DisputePanel";
import { AgentBadge } from "@/components/AgentBadge";
import { IPFSMarkdownClient } from "@/components/IPFSMarkdownClient";
import { useBountyMeta } from "@/hooks/useBountyMeta";
import { useTx } from "@/hooks/useTx";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export default function BountyPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { address } = useAccount();
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [agentIdInput, setAgentIdInput] = useState("0");

  const jobIdBig = BigInt(jobId);
  const { meta, refetch } = useBountyMeta(jobIdBig);
  const { send } = useTx();

  if (!meta) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="h-12 bg-white/5 rounded-xl animate-pulse w-1/2" />
        <div className="h-64 bg-white/5 border border-white/10 rounded-xl animate-pulse" />
      </div>
    );
  }

  const { label: timeLeft, expired } = secondsToDeadline(meta.deadline);
  const isPoster   = address?.toLowerCase() === meta.poster.toLowerCase();
  const isProvider = address?.toLowerCase() === meta.assignedProvider.toLowerCase();
  const isOpen     = !meta.isTaken;
  const hasSubmission = meta.submittedResultHash.length > 0;
  const inDispute = meta.inDispute || (meta.resolved && meta.disputeRulingHash.length > 0);

  async function handleTake() {
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "takeBounty",
        args: [jobIdBig, BigInt(agentIdInput || "0")],
      },
      { pending: "Taking bounty…", success: "Bounty taken! USDC locked in escrow.", error: "Failed to take bounty" }
    );
    await refetch();
  }

  async function handleApprove() {
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "approveBounty",
        args: [jobIdBig, 95],
      },
      { pending: "Approving work…", success: "Work approved! USDC sent to provider.", error: "Approval failed" }
    );
    await refetch();
  }

  async function handleReject() {
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "rejectBounty",
        args: [jobIdBig, "Rejected by poster"],
      },
      { pending: "Rejecting submission…", success: "Submission rejected. USDC returned.", error: "Rejection failed" }
    );
    await refetch();
  }

  async function handleCancel() {
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "cancelBounty",
        args: [jobIdBig],
      },
      { pending: "Cancelling bounty…", success: "Bounty cancelled. USDC returned.", error: "Cancellation failed" }
    );
    await refetch();
  }

  async function handleExpire() {
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "expireBounty",
        args: [jobIdBig],
      },
      { pending: "Triggering expiry…", success: "Bounty expired. USDC returned to poster.", error: "Expiry failed" }
    );
    await refetch();
  }

  // Whitelist gate for take button
  const whitelisted = meta.whitelistedProvider !== ZERO_ADDRESS;
  const isWhitelistedCaller = address && whitelisted && address.toLowerCase() === meta.whitelistedProvider.toLowerCase();
  const canTake = isOpen && !isPoster && !expired && !meta.resolved && (!whitelisted || isWhitelistedCaller);

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-6">
        <Link href="/" className="hover:text-white transition-colors">Browse</Link>
        <span>/</span>
        <Link href={`/category/${meta.category}`} className="hover:text-white transition-colors capitalize">
          {meta.category}
        </Link>
        <span>/</span>
        <span className="text-gray-300">#{jobId}</span>
      </div>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <Link href={`/category/${meta.category}`}>
              <span className="text-xs px-2 py-0.5 rounded-full border border-white/20 text-gray-200 hover:border-white/40 capitalize cursor-pointer transition-colors">
                {meta.category}
              </span>
            </Link>
            {meta.agentOnly && (
              <span className="text-xs px-2 py-0.5 rounded-full border border-violet-700 bg-violet-900/50 text-violet-300">
                Agent only
              </span>
            )}
            {meta.humanOnly && (
              <span className="text-xs px-2 py-0.5 rounded-full border border-orange-700 bg-orange-900/40 text-orange-300">
                Human only
              </span>
            )}
            <StatusBadge meta={meta} expired={expired} />
          </div>
          <h1 className="text-2xl font-bold">Bounty #{jobId}</h1>
          <p className="text-gray-400 text-sm mt-1">
            Posted by <span className="font-mono text-gray-200">{shortAddress(meta.poster)}</span>
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-3xl font-bold text-green-300 drop-shadow">${formatUsdc(meta.reward)}</div>
          <div className={`text-sm mt-1 font-mono ${expired ? "text-red-300" : "text-gray-300"}`}>
            {timeLeft}
          </div>
        </div>
      </div>

      {meta.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {meta.tags.map(tag => (
            <span key={tag} className="text-xs text-gray-200 bg-white/5 border border-white/10 px-2 py-1 rounded">{tag}</span>
          ))}
        </div>
      )}

      <div className="glass rounded-xl p-6 mb-6">
        <h2 className="text-xs font-semibold text-gray-300 mb-3 uppercase tracking-widest">Description</h2>
        <IPFSMarkdownClient cid={meta.ipfsDescHash} />
      </div>

      {meta.agentId > 0n && (
        <div className="mb-6"><AgentBadge agentId={meta.agentId} /></div>
      )}

      {!isOpen && (
        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-xl p-4 mb-6 text-sm">
          <span className="text-gray-300">Assigned to: </span>
          <span className="font-mono text-white">{shortAddress(meta.assignedProvider)}</span>
        </div>
      )}

      {hasSubmission && (
        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-xl p-6 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-gray-300 uppercase tracking-widest">Submitted work</h2>
            <a
              href={`https://ipfs.io/ipfs/${meta.submittedResultHash.replace("ipfs://", "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-400 hover:text-gray-200 underline font-mono"
            >
              raw ↗
            </a>
          </div>
          <IPFSMarkdownClient cid={meta.submittedResultHash} />
        </div>
      )}

      {/* Dispute panel — visible to everyone once a dispute exists */}
      {inDispute && (
        <DisputePanel meta={meta} address={address} refetch={refetch} />
      )}

      {/* Actions — hidden once dispute is open (handled by panel) */}
      {!meta.inDispute && !meta.resolved && (
        <div className="space-y-3">
          {canTake && (
            <div className="space-y-2">
              {meta.agentOnly && (
                <input
                  type="text"
                  placeholder="Your ERC-8004 Agent ID"
                  value={agentIdInput}
                  onChange={e => setAgentIdInput(e.target.value)}
                  className="w-full bg-white/5 border border-white/20 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-400"
                />
              )}
              <button
                onClick={handleTake}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-colors"
              >
                Take this Bounty
              </button>
            </div>
          )}

          {!canTake && isOpen && whitelisted && !isWhitelistedCaller && !isPoster && (
            <div className="text-sm text-gray-300 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
              This bounty is whitelisted to {shortAddress(meta.whitelistedProvider)} — only that wallet can take it.
            </div>
          )}

          {isProvider && !hasSubmission && !expired && (
            <button
              onClick={() => setShowSubmitModal(true)}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-colors"
            >
              Submit Work
            </button>
          )}

          {isPoster && hasSubmission && (
            <div className="grid grid-cols-3 gap-3">
              <button
                onClick={handleApprove}
                className="bg-green-600 hover:bg-green-500 text-white font-semibold py-3 rounded-xl transition-colors"
              >
                Approve & Pay
              </button>
              <button
                onClick={handleReject}
                className="bg-red-800 hover:bg-red-700 text-white font-semibold py-3 rounded-xl transition-colors"
              >
                Reject
              </button>
              <button
                onClick={() => setShowDisputeModal(true)}
                className="bg-red-950 hover:bg-red-900 border border-red-800 text-red-200 font-semibold py-3 rounded-xl transition-colors"
              >
                Dispute
              </button>
            </div>
          )}

          {isProvider && hasSubmission && (
            <button
              onClick={() => setShowDisputeModal(true)}
              className="w-full bg-red-950 hover:bg-red-900 border border-red-800 text-red-200 font-semibold py-3 rounded-xl transition-colors"
            >
              Open dispute (poster won&apos;t respond)
            </button>
          )}

          {isPoster && isOpen && (
            <button
              onClick={handleCancel}
              className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-gray-200 py-3 rounded-xl transition-colors text-sm"
            >
              Cancel Bounty
            </button>
          )}

          {expired && !hasSubmission && (
            <button
              onClick={handleExpire}
              className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-gray-200 py-3 rounded-xl transition-colors text-sm"
            >
              Trigger Expiry (return USDC to poster)
            </button>
          )}
        </div>
      )}

      {meta.resolved && !inDispute && (
        <div className="bg-black/30 border border-white/10 rounded-xl p-4 text-sm text-gray-200">
          This bounty has been resolved.
        </div>
      )}

      {showSubmitModal && (
        <WorkSubmitModal
          jobId={jobIdBig}
          onSuccess={() => { setShowSubmitModal(false); void refetch(); }}
          onClose={() => setShowSubmitModal(false)}
        />
      )}
      {showDisputeModal && (
        <DisputeOpenModal
          jobId={jobIdBig}
          onSuccess={() => refetch()}
          onClose={() => setShowDisputeModal(false)}
        />
      )}
    </div>
  );
}

function StatusBadge({
  meta,
  expired,
}: {
  meta: { isTaken: boolean; submittedResultHash: string; inDispute: boolean; resolved: boolean };
  expired: boolean;
}) {
  if (meta.inDispute) {
    return <span className="text-xs font-semibold text-red-300 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse inline-block" />In dispute</span>;
  }
  if (meta.resolved) {
    return <span className="text-xs font-semibold text-gray-300">Resolved</span>;
  }
  if (meta.submittedResultHash) {
    return <span className="text-xs font-semibold text-yellow-300 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse inline-block" />Submitted</span>;
  }
  if (meta.isTaken) {
    return <span className="text-xs font-semibold text-blue-300 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />Assigned</span>;
  }
  if (expired) {
    return <span className="text-xs font-semibold text-red-300">Expired</span>;
  }
  return <span className="text-xs font-semibold text-green-300 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />Open</span>;
}
