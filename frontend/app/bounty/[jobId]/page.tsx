"use client";

import { useState, useMemo } from "react";
import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import { keccak256, encodeAbiParameters, toHex, type Hex } from "viem";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { formatUsdc, shortAddress, secondsToDeadline } from "@/lib/format";
import { WorkSubmitModal } from "@/components/WorkSubmitModal";
import { AgentBadge } from "@/components/AgentBadge";
import { IPFSMarkdownClient } from "@/components/IPFSMarkdownClient";
import { useBountyMeta } from "@/hooks/useBountyMeta";
import { useTx } from "@/hooks/useTx";
import Link from "next/link";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DISPUTE_WINDOW_SEC = 48 * 3600;
const COMMIT_REVEAL_STORAGE_KEY = (jobId: string) => `arcbounty:commit:${jobId}`;

function randomSalt(): Hex {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return toHex(arr);
}

export default function BountyPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { address } = useAccount();
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [agentIdInput, setAgentIdInput] = useState("0");
  const [approveScore, setApproveScore] = useState("95");
  const [penaltyScore, setPenaltyScore] = useState("10");

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
  const isOpen     = !meta.isTaken && !meta.finalized;
  const hasSubmission = meta.submittedResultHash.length > 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const disputeWindowEnd = Number(meta.submittedAt) + DISPUTE_WINDOW_SEC;
  const inDisputeWindow = hasSubmission && nowSec <= disputeWindowEnd && !meta.finalized && !meta.inDispute;
  const disputeWindowPassed = hasSubmission && nowSec > disputeWindowEnd && !meta.finalized && !meta.inDispute;

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

  async function handleCommit() {
    const salt = randomSalt();
    const agentIdBig = BigInt(agentIdInput || "0");
    const commitment = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
        [jobIdBig, address!, agentIdBig, salt],
      ),
    );
    localStorage.setItem(
      COMMIT_REVEAL_STORAGE_KEY(jobId),
      JSON.stringify({ salt, agentId: agentIdInput || "0", address }),
    );
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "commitTake",
        args: [jobIdBig, commitment],
      },
      { pending: "Committing…", success: "Commitment posted. Wait ≥ 2 blocks then reveal.", error: "Commit failed" }
    );
    await refetch();
  }

  async function handleReveal() {
    const raw = localStorage.getItem(COMMIT_REVEAL_STORAGE_KEY(jobId));
    if (!raw) {
      alert("No saved commitment for this bounty in this browser. Use the same browser/wallet that committed.");
      return;
    }
    const saved = JSON.parse(raw) as { salt: Hex; agentId: string; address: string };
    if (saved.address.toLowerCase() !== address?.toLowerCase()) {
      alert("Commitment belongs to a different wallet.");
      return;
    }
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "revealTake",
        args: [jobIdBig, BigInt(saved.agentId), saved.salt],
      },
      { pending: "Revealing…", success: "Reveal succeeded — bounty assigned!", error: "Reveal failed (too early? expired?)" }
    );
    localStorage.removeItem(COMMIT_REVEAL_STORAGE_KEY(jobId));
    await refetch();
  }

  async function handleApprove() {
    const score = Math.max(0, Math.min(100, parseInt(approveScore, 10) || 0));
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "approveBounty",
        args: [jobIdBig, score],
      },
      { pending: "Approving work…", success: "Work approved! USDC sent to provider.", error: "Approval failed" }
    );
    await refetch();
  }

  async function handleAutoApprove() {
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "autoApprove",
        args: [jobIdBig],
      },
      { pending: "Auto-approving…", success: "Auto-approved after dispute window. USDC sent.", error: "Auto-approve failed" }
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

  async function handleDispute() {
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "disputeBounty",
        args: [jobIdBig],
      },
      { pending: "Raising dispute…", success: "Dispute raised. Awaiting arbitrator.", error: "Dispute failed" }
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

  const disputeWindowLabel = useMemo(() => {
    if (!hasSubmission || meta.finalized) return null;
    const remaining = disputeWindowEnd - nowSec;
    if (remaining <= 0) return "Dispute window closed";
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    return `Dispute window: ${h}h ${m}m left`;
  }, [hasSubmission, meta.finalized, disputeWindowEnd, nowSec]);

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
            {meta.commitRevealRequired && (
              <span className="text-xs px-2 py-0.5 rounded-full border border-amber-700 bg-amber-900/40 text-amber-300">
                MEV-protected
              </span>
            )}
            {meta.whitelistedProvider !== ZERO_ADDRESS && (
              <span className="text-xs px-2 py-0.5 rounded-full border border-pink-700 bg-pink-900/40 text-pink-300" title={meta.whitelistedProvider}>
                Whitelisted only
              </span>
            )}
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
            <>
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
              {disputeWindowLabel && (
                <div className="text-xs text-amber-400 mt-1">{disputeWindowLabel}</div>
              )}
            </>
          )}
        </div>
      )}

      {meta.inDispute && (
        <div className="bg-red-900/30 border border-red-800 rounded-xl p-4 mb-6 text-sm text-red-300">
          ⚖️ This bounty is in dispute. Awaiting arbitrator resolution.
        </div>
      )}

      {meta.finalized && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 mb-6 text-sm text-gray-400">
          ✓ Finalized. No further actions possible.
        </div>
      )}

      {/* Actions */}
      <div className="space-y-3">
        {/* Take bounty — regular path */}
        {isOpen && !isPoster && !expired && !meta.commitRevealRequired && (
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

        {/* Take bounty — commit-reveal path */}
        {isOpen && !isPoster && !expired && meta.commitRevealRequired && (
          <div className="space-y-2 border border-amber-800 bg-amber-900/10 rounded-xl p-4">
            <p className="text-xs text-amber-300">
              This bounty uses commit-reveal MEV protection. Step 1: commit. Wait ≥ 2 blocks. Step 2: reveal.
              <br />
              Your salt is saved in this browser's localStorage — reveal from the same wallet/browser.
            </p>
            {meta.agentOnly && (
              <input
                type="text"
                placeholder="Your ERC-8004 Agent ID"
                value={agentIdInput}
                onChange={e => setAgentIdInput(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-amber-500"
              />
            )}
            <div className="flex gap-2">
              <button onClick={handleCommit} className="flex-1 bg-amber-700 hover:bg-amber-600 text-white py-2.5 rounded-xl text-sm font-semibold">
                1. Commit
              </button>
              <button onClick={handleReveal} className="flex-1 bg-amber-600 hover:bg-amber-500 text-white py-2.5 rounded-xl text-sm font-semibold">
                2. Reveal
              </button>
            </div>
          </div>
        )}

        {/* Submit work (provider) */}
        {isProvider && meta.funded && !hasSubmission && !expired && !meta.finalized && (
          <button
            onClick={() => setShowSubmitModal(true)}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-colors"
          >
            Submit Work
          </button>
        )}

        {/* Approve / Reject (poster) */}
        {isPoster && hasSubmission && !meta.inDispute && !meta.finalized && inDisputeWindow && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400">Reputation score (0–100):</label>
              <input
                type="number"
                min={0}
                max={100}
                value={approveScore}
                onChange={e => setApproveScore(e.target.value)}
                className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-green-500"
              />
            </div>
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
          </div>
        )}

        {/* Dispute (poster or provider, after submission, within window) */}
        {(isPoster || isProvider) && inDisputeWindow && (
          <button
            onClick={handleDispute}
            className="w-full bg-amber-800 hover:bg-amber-700 text-white py-2.5 rounded-xl transition-colors text-sm font-medium"
          >
            ⚖️ Raise Dispute
          </button>
        )}

        {/* Auto-approve (provider, after window) */}
        {isProvider && disputeWindowPassed && (
          <button
            onClick={handleAutoApprove}
            className="w-full bg-green-700 hover:bg-green-600 text-white font-semibold py-3 rounded-xl transition-colors"
          >
            Auto-approve & Pay (window passed)
          </button>
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

        {/* Expire (anyone, after deadline, no submission) */}
        {expired && !hasSubmission && !meta.finalized && (
          <button
            onClick={handleExpire}
            className="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 py-3 rounded-xl transition-colors text-sm"
          >
            Trigger Expiry (return USDC to poster)
          </button>
        )}
      </div>

      {/* Arbitrator helper (only show if someone is arbitrator — backend would know; skipped for MVP) */}
      {meta.inDispute && (
        <div className="mt-4 text-xs text-gray-500">
          Arbitrator can call <code className="text-gray-300">resolveDispute(jobId, payProvider, penalty)</code> directly.
          Penalty score (0–100) suggested:
          <input
            type="number"
            min={0}
            max={100}
            value={penaltyScore}
            onChange={e => setPenaltyScore(e.target.value)}
            className="ml-2 w-16 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs"
          />
        </div>
      )}

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

function StatusBadge({ meta, expired }: {
  meta: { assignedProvider: string; submittedResultHash: string; inDispute: boolean; finalized: boolean };
  expired: boolean;
}) {
  if (meta.finalized) {
    return <span className="text-xs font-semibold text-gray-400">Finalized</span>;
  }
  if (meta.inDispute) {
    return <span className="text-xs font-semibold text-red-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse inline-block" />Disputed</span>;
  }
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
