"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import Link from "next/link";
import { useMyAgentId } from "@/hooks/useMyAgentId";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { formatUsdc, shortAddress, secondsToDeadline } from "@/lib/format";
import { WorkSubmitModal } from "@/components/WorkSubmitModal";
import { DisputeOpenModal } from "@/components/DisputeOpenModal";
import { DisputePanel } from "@/components/DisputePanel";
import { RejectionProposeModal } from "@/components/RejectionProposeModal";
import { PendingRejectionPanel } from "@/components/PendingRejectionPanel";
import { AgentBadge } from "@/components/AgentBadge";
import { IPFSMarkdownClient } from "@/components/IPFSMarkdownClient";
import { useBountyMeta } from "@/hooks/useBountyMeta";
import { useTx } from "@/hooks/useTx";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const KNOWN_CATS = new Set(["dev", "design", "content", "data", "other"]);

type StatusKind = "open" | "submitted" | "in-review" | "paid" | "expired";

function statusOf(meta: {
  isTaken: boolean;
  submittedResultHash: string;
  inDispute: boolean;
  resolved: boolean;
  rejectedAt: bigint;
}, expired: boolean): { kind: StatusKind; label: string } {
  if (meta.inDispute) return { kind: "in-review", label: "In Dispute" };
  if (meta.resolved) return { kind: "paid", label: "Resolved" };
  if (meta.rejectedAt > 0n) return { kind: "submitted", label: "Pending Rejection" };
  if (meta.submittedResultHash) return { kind: "submitted", label: "Submitted" };
  if (meta.isTaken) return { kind: "in-review", label: "Assigned" };
  if (expired) return { kind: "expired", label: "Expired" };
  return { kind: "open", label: "Open" };
}

export default function BountyPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { address } = useAccount();
  const [showSubmitModal, setShowSubmitModal]   = useState(false);
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [showRejectModal, setShowRejectModal]   = useState(false);
  const [agentIdInput, setAgentIdInput]         = useState("");
  const [agentIdAuto, setAgentIdAuto]           = useState(false);
  const { agentId: myAgentId }                  = useMyAgentId(address);

  // Prefill the agent-id input once the connected wallet's agent is known.
  useEffect(() => {
    if (myAgentId && myAgentId > 0n && !agentIdInput) {
      setAgentIdInput(myAgentId.toString());
      setAgentIdAuto(true);
    }
  }, [myAgentId, agentIdInput]);

  const jobIdBig = BigInt(jobId);
  const { meta, refetch } = useBountyMeta(jobIdBig);
  const { send } = useTx();

  if (!meta) {
    return (
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <div className="row" style={{ height: 60, opacity: 0.5, marginBottom: 18 }} />
        <div className="row" style={{ height: 280, opacity: 0.5 }} />
      </div>
    );
  }

  const { label: timeLeft, expired } = secondsToDeadline(meta.deadline);
  const isPoster        = address?.toLowerCase() === meta.poster.toLowerCase();
  const isProvider      = address?.toLowerCase() === meta.assignedProvider.toLowerCase();
  const isOpen          = !meta.isTaken;
  const hasSubmission   = meta.submittedResultHash.length > 0;
  const inDispute       = meta.inDispute || (meta.resolved && meta.disputeRulingHash.length > 0);
  const pendingRejection = meta.rejectedAt > 0n && !meta.resolved && !meta.inDispute;
  const catClass        = KNOWN_CATS.has(meta.category) ? `cat-${meta.category}` : "cat-other";
  const status          = statusOf(meta, expired);

  async function handleTake() {
    const trimmed = agentIdInput.trim();
    const agentIdBig = trimmed && /^\d+$/.test(trimmed) ? BigInt(trimmed) : 0n;
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "takeBounty",
        args: [jobIdBig, agentIdBig],
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

  const whitelisted = meta.whitelistedProvider !== ZERO_ADDRESS;
  const isWhitelistedCaller = address && whitelisted && address.toLowerCase() === meta.whitelistedProvider.toLowerCase();
  const canTake = isOpen && !isPoster && !expired && !meta.resolved && (!whitelisted || isWhitelistedCaller);

  return (
    <div style={{ maxWidth: 920, margin: "0 auto" }}>
      {/* Breadcrumb */}
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Browse</Link>
        <span className="sep">/</span>
        <Link href={`/category/${meta.category}`} style={{ textTransform: "capitalize" }}>{meta.category}</Link>
        <span className="sep">/</span>
        <span className="current">#{jobId}</span>
      </nav>

      {/* Head */}
      <header className="bounty-head">
        <div>
          <div className="top-line">
            <span className={`tag ${catClass}`}>{meta.category}</span>
            {meta.agentOnly && <span className="tag agent-only">Agent only</span>}
            {meta.humanOnly && <span className="tag human-only">Human only</span>}
            <span className={`status ${status.kind}`}>{status.label}</span>
          </div>
          <h1>Bounty #{jobId}</h1>
          <div className="posted-by">
            Posted by <code>{shortAddress(meta.poster)}</code>
          </div>
          {meta.tags.length > 0 && (
            <div className="subtags">
              {meta.tags.map(tag => (
                <span key={tag} className="subtag">{tag}</span>
              ))}
            </div>
          )}
        </div>
        <div className="bounty-price">
          <div className="price">${formatUsdc(meta.reward)}</div>
          <div className="time">{timeLeft}</div>
        </div>
      </header>

      {/* Description */}
      <section className="desc-card">
        <div className="label">Description</div>
        <IPFSMarkdownClient cid={meta.ipfsDescHash} />
      </section>

      {/* Agent badge */}
      {meta.agentId > 0n && (
        <div style={{ marginTop: 18 }}>
          <AgentBadge agentId={meta.agentId} />
        </div>
      )}

      {/* Assignment info */}
      {!isOpen && (
        <div
          style={{
            marginTop: 18,
            padding: "12px 18px",
            borderRadius: 14,
            background: "var(--g-bg)",
            border: "1px solid var(--g-border)",
            backdropFilter: "var(--g-blur)",
            WebkitBackdropFilter: "var(--g-blur)",
            fontSize: 13,
            color: "var(--ink-soft)",
          }}
        >
          <span style={{ color: "var(--ink-mute)" }}>Assigned to: </span>
          <code style={{ fontFamily: '"JetBrains Mono", monospace', color: "var(--ink)" }}>
            {shortAddress(meta.assignedProvider)}
          </code>
        </div>
      )}

      {/* Submitted work */}
      {hasSubmission && (
        <section className="desc-card" style={{ marginTop: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <span className="label" style={{ marginBottom: 0 }}>Submitted work</span>
            <a
              href={`https://ipfs.io/ipfs/${meta.submittedResultHash.replace("ipfs://", "")}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 11,
                color: "var(--ink-mute)",
                textDecoration: "underline",
              }}
            >
              raw ↗
            </a>
          </div>
          <IPFSMarkdownClient cid={meta.submittedResultHash} />
        </section>
      )}

      {/* Dispute panel — unchanged component */}
      {inDispute && (
        <div style={{ marginTop: 22 }}>
          <DisputePanel meta={meta} address={address} refetch={refetch} />
        </div>
      )}

      {/* Pending rejection panel — unchanged component */}
      {pendingRejection && (
        <div style={{ marginTop: 22 }}>
          <PendingRejectionPanel meta={meta} address={address} refetch={refetch} />
        </div>
      )}

      {/* Action bar */}
      {!meta.inDispute && !meta.resolved && !pendingRejection && (
        <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 12 }}>
          {canTake && (() => {
            const parsedId = (() => {
              const s = agentIdInput.trim();
              if (!s) return null;
              if (!/^\d+$/.test(s)) return null;
              try { return BigInt(s); } catch { return null; }
            })();
            const agentIdValid = parsedId !== null && parsedId > 0n;
            const canSubmit = meta.agentOnly ? agentIdValid : true;

            return (
              <>
                {meta.agentOnly && (
                  <div className="form-row">
                    <label className="form-label" htmlFor="take-agent-id">
                      ERC-8004 Agent ID
                      <span className="hint">
                        {agentIdAuto ? "auto-filled from your wallet" : "required — this is an Agent-only bounty"}
                      </span>
                    </label>
                    <input
                      id="take-agent-id"
                      className="input"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder="e.g. 42 — the numeric ID of an agent you own"
                      value={agentIdInput}
                      onChange={e => { setAgentIdInput(e.target.value.replace(/\D/g, "")); setAgentIdAuto(false); }}
                    />
                    {myAgentId === null && (
                      <p style={{ fontSize: 12, color: "var(--ink-mute)", margin: "6px 2px 0", lineHeight: 1.5 }}>
                        Don&apos;t have one yet?{" "}
                        <Link href="/register-agent" style={{ color: "var(--honey)", textDecoration: "underline" }}>
                          Register an agent →
                        </Link>{" "}
                        It mints an ERC-8004 NFT to your wallet; the tokenId is your agentId.
                      </p>
                    )}
                  </div>
                )}
                <button
                  onClick={handleTake}
                  disabled={!canSubmit}
                  className="btn btn-primary btn-big"
                >
                  {meta.agentOnly && !agentIdValid ? "Enter a valid Agent ID" : "Take this Bounty"}
                </button>
              </>
            );
          })()}

          {!canTake && isOpen && whitelisted && !isWhitelistedCaller && !isPoster && (
            <div
              style={{
                padding: "12px 18px",
                borderRadius: 14,
                background: "var(--g-bg)",
                border: "1px solid var(--g-border)",
                backdropFilter: "var(--g-blur)",
                WebkitBackdropFilter: "var(--g-blur)",
                fontSize: 13,
                color: "var(--ink-soft)",
              }}
            >
              This bounty is whitelisted to {shortAddress(meta.whitelistedProvider)} — only that wallet can take it.
            </div>
          )}

          {isProvider && !hasSubmission && !expired && (
            <button onClick={() => setShowSubmitModal(true)} className="btn btn-primary btn-big">
              Submit Work
            </button>
          )}

          {isPoster && hasSubmission && (
            <>
              <div className="action-bar">
                <button onClick={handleApprove} className="btn btn-primary btn-big">
                  Approve &amp; Pay
                </button>
                <button onClick={() => setShowRejectModal(true)} className="btn btn-danger btn-big">
                  Reject
                </button>
              </div>
              <button
                onClick={() => setShowDisputeModal(true)}
                title="Hand the decision to a third-party arbitrator instead of approving/rejecting yourself."
                style={{
                  appearance: "none",
                  background: "transparent",
                  border: 0,
                  color: "var(--ink-mute)",
                  fontSize: 12,
                  textDecoration: "underline",
                  cursor: "pointer",
                  padding: "4px 0",
                }}
              >
                Escalate to arbitrator instead →
              </button>
            </>
          )}

          {isProvider && hasSubmission && (
            <>
              <button onClick={() => setShowDisputeModal(true)} className="btn btn-danger btn-big">
                Open dispute
              </button>
              <p style={{ fontSize: 12, color: "var(--ink-mute)", margin: 0, lineHeight: 1.5 }}>
                Use this if you think the poster will reject your work unfairly, or hasn&apos;t responded.
                Opening a dispute blocks unilateral approve/reject — an arbitrator decides instead.
              </p>
            </>
          )}

          {isPoster && isOpen && (
            <button onClick={handleCancel} className="btn">
              Cancel Bounty
            </button>
          )}

          {expired && !hasSubmission && (
            <button onClick={handleExpire} className="btn">
              Trigger Expiry (return USDC to poster)
            </button>
          )}
        </div>
      )}

      {meta.resolved && !inDispute && (
        <div
          style={{
            marginTop: 22,
            padding: "12px 18px",
            borderRadius: 14,
            background: "rgba(10,14,28,0.42)",
            border: "1px solid var(--g-border)",
            backdropFilter: "var(--g-blur)",
            WebkitBackdropFilter: "var(--g-blur)",
            fontSize: 13,
            color: "var(--ink-soft)",
          }}
        >
          This bounty has been resolved.
        </div>
      )}

      <footer className="spacer" />

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
      {showRejectModal && (
        <RejectionProposeModal
          jobId={jobIdBig}
          onSuccess={() => refetch()}
          onClose={() => setShowRejectModal(false)}
        />
      )}
    </div>
  );
}
