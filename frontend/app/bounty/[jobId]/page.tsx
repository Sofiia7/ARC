"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { formatUsdc, shortAddress, secondsToDeadline } from "@/lib/format";
import { FundFlow } from "@/components/FundFlow";
import { WorkSubmitModal } from "@/components/WorkSubmitModal";
import { AgentBadge } from "@/components/AgentBadge";
import { IPFSMarkdownClient } from "@/components/IPFSMarkdownClient";
import { useBountyMeta } from "@/hooks/useBountyMeta";
import { useTx } from "@/hooks/useTx";
import Link from "next/link";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export default function BountyPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { address } = useAccount();
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [agentIdInput, setAgentIdInput] = useState("0");

  const jobIdBig = BigInt(jobId);
  const { meta, refetch } = useBountyMeta(jobIdBig);
  const { send } = useTx();

  if (!meta) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="h-12 bg-gray-900 rounded-xl animate-pulse w-1/2" />
        <div className="h-64 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />
      </div>
    );
  }

  const { label: timeLeft, expired } = secondsToDeadline(meta.deadline);
  const isPoster   = address?.toLowerCase() === meta.poster.toLowerCase();
  const isProvider = address?.toLowerCase() === meta.assignedProvider.toLowerCase();
  const isOpen     = meta.assignedProvider === ZERO_ADDRESS;
  const hasSubmission = meta.submittedResultHash.length > 0;

  async function handleTake() {
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "takeBounty",
        args: [jobIdBig, BigInt(agentIdInput || "0")],
      },
      { pending: "Taking bounty…", success: "Bounty taken! Time to get to work.", error: "Failed to take bounty" }
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

  return (
    <div className="max-w-3xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-6">
        <Link href="/" className="hover:text-white transition-colors">Browse</Link>
        <span>/</span>
        <Link href={`/category/${meta.category}`} className="hover:text-white transition-colors capitalize">
          {meta.category}
        </Link>
        <span>/</span>
        <span className="text-gray-400">#{jobId}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <Link href={`/category/${meta.category}`}>
              <span className="text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-400 hover:border-gray-500 capitalize cursor-pointer transition-colors">
                {meta.category}
              </span>
            </Link>
            {meta.agentOnly && (
              <span className="text-xs px-2 py-0.5 rounded-full border border-violet-700 bg-violet-900/50 text-violet-300">
                Agent only
              </span>
            )}
            {/* Live status badge */}
            <StatusBadge meta={meta} expired={expired} />
          </div>
          <h1 className="text-2xl font-bold">Bounty #{jobId}</h1>
          <p className="text-gray-500 text-sm mt-1">
            Posted by <span className="font-mono text-gray-400">{shortAddress(meta.poster)}</span>
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-3xl font-bold text-green-400">${formatUsdc(meta.reward)}</div>
          <div className={`text-sm mt-1 font-mono ${expired ? "text-red-400" : "text-gray-500"}`}>
            {timeLeft}
          </div>
        </div>
      </div>

      {/* Tags */}
      {meta.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {meta.tags.map(tag => (
            <span key={tag} className="text-xs text-gray-400 bg-gray-800 px-2 py-1 rounded">{tag}</span>
          ))}
        </div>
      )}

      {/* Description */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 className="text-xs font-semibold text-gray-500 mb-3 uppercase tracking-widest">Description</h2>
        <IPFSMarkdownClient cid={meta.ipfsDescHash} />
      </div>

      {/* Agent badge */}
      {meta.agentId > 0n && (
        <div className="mb-6"><AgentBadge agentId={meta.agentId} /></div>
      )}

      {/* Provider + submission */}
      {!isOpen && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6 text-sm space-y-2">
          <div>
            <span className="text-gray-500">Assigned to: </span>
            <span className="font-mono text-white">{shortAddress(meta.assignedProvider)}</span>
          </div>
          {hasSubmission && (
            <div>
              <span className="text-gray-500">Submitted: </span>
              <a
                href={`https://ipfs.io/ipfs/${meta.submittedResultHash.replace("ipfs://", "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-blue-400 hover:text-blue-300 underline break-all"
              >
                {meta.submittedResultHash}
              </a>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="space-y-3">
        {/* Take bounty */}
        {isOpen && !isPoster && !expired && (
          <div className="space-y-2">
            {meta.agentOnly && (
              <input
                type="text"
                placeholder="Your ERC-8004 Agent ID"
                value={agentIdInput}
                onChange={e => setAgentIdInput(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500"
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

        {/* Fund (poster) */}
        {isPoster && !meta.funded && !isOpen && (
          <FundFlow jobId={jobIdBig} reward={meta.reward} onSuccess={() => refetch()} />
        )}

        {/* Submit work (provider) */}
        {isProvider && meta.funded && !hasSubmission && !expired && (
          <button
            onClick={() => setShowSubmitModal(true)}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-colors"
          >
            Submit Work
          </button>
        )}

        {/* Approve / Reject (poster) */}
        {isPoster && hasSubmission && (
          <div className="flex gap-3">
            <button
              onClick={handleApprove}
              className="flex-1 bg-green-600 hover:bg-green-500 text-white font-semibold py-3 rounded-xl transition-colors"
            >
              Approve & Pay
            </button>
            <button
              onClick={handleReject}
              className="flex-1 bg-red-800 hover:bg-red-700 text-white font-semibold py-3 rounded-xl transition-colors"
            >
              Reject
            </button>
          </div>
        )}

        {/* Cancel (poster, open only) */}
        {isPoster && isOpen && (
          <button
            onClick={handleCancel}
            className="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 py-3 rounded-xl transition-colors text-sm"
          >
            Cancel Bounty
          </button>
        )}

        {/* Expire (anyone, after deadline) */}
        {expired && (
          <button
            onClick={handleExpire}
            className="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 py-3 rounded-xl transition-colors text-sm"
          >
            Trigger Expiry (return USDC to poster)
          </button>
        )}
      </div>

      {showSubmitModal && (
        <WorkSubmitModal
          jobId={jobIdBig}
          onSuccess={() => { setShowSubmitModal(false); void refetch(); }}
          onClose={() => setShowSubmitModal(false)}
        />
      )}
    </div>
  );
}

function StatusBadge({ meta, expired }: { meta: { assignedProvider: string; submittedResultHash: string }; expired: boolean }) {
  if (meta.submittedResultHash) {
    return <span className="text-xs font-semibold text-yellow-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse inline-block" />Submitted</span>;
  }
  if (meta.assignedProvider !== ZERO_ADDRESS) {
    return <span className="text-xs font-semibold text-blue-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />Assigned</span>;
  }
  if (expired) {
    return <span className="text-xs font-semibold text-red-400">Expired</span>;
  }
  return <span className="text-xs font-semibold text-green-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />Open</span>;
}
