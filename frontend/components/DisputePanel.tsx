"use client";

import { useState, useEffect, useRef } from "react";
import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { toast } from "sonner";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { useTx } from "@/hooks/useTx";
import { shortAddress } from "@/lib/format";
import { pinText } from "@/lib/ipfs";
import { IPFSMarkdownClient } from "./IPFSMarkdownClient";
import { FileAttacher } from "./FileAttacher";
import type { BountyMeta } from "./BountyCard";

type Role = "poster" | "provider" | "arbitrator" | "observer";

function roleFor(address: string | undefined, meta: BountyMeta, arbitrator: string | undefined): Role {
  if (!address) return "observer";
  const a = address.toLowerCase();
  if (a === meta.poster.toLowerCase()) return "poster";
  if (a === meta.assignedProvider.toLowerCase()) return "provider";
  if (arbitrator && a === arbitrator.toLowerCase()) return "arbitrator";
  return "observer";
}

export function DisputePanel({
  meta,
  address,
  refetch,
}: {
  meta: BountyMeta;
  address: Address | undefined;
  refetch: () => void | Promise<unknown>;
}) {
  const { send } = useTx();

  const arbitratorRead = useReadContract({
    address: CONTRACTS.BOUNTY_ADAPTER,
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "arbitrator",
  });
  const arbitrator = arbitratorRead.data as string | undefined;
  const role = roleFor(address, meta, arbitrator);

  const initiatorIsPoster   = meta.disputeInitiator.toLowerCase() === meta.poster.toLowerCase();
  const initiatorIsProvider = meta.disputeInitiator.toLowerCase() === meta.assignedProvider.toLowerCase();
  const respondentRole: Role = initiatorIsPoster ? "provider" : "poster";

  const hasResponse  = meta.disputeResponseHash.length > 0;
  const hasRuling    = meta.disputeRulingHash.length > 0;
  const responseDeadline = meta.disputeRaisedAt + 48n * 3600n;
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const t = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(t);
  }, []);
  const windowClosed = now > responseDeadline;
  const secondsLeft = responseDeadline > now ? Number(responseDeadline - now) : 0;
  const hoursLeft = Math.floor(secondsLeft / 3600);
  const minutesLeft = Math.floor((secondsLeft % 3600) / 60);

  const canRespond = role === respondentRole && !hasResponse && !windowClosed && !meta.resolved;
  const [respText, setRespText] = useState("");
  const respRef = useRef<HTMLTextAreaElement>(null);
  function insertIntoResp(snippet: string) {
    setRespText(prev => {
      const ta = respRef.current;
      if (!ta) return `${prev}${prev ? "\n\n" : ""}${snippet}\n`;
      const start = ta.selectionStart ?? prev.length;
      const end   = ta.selectionEnd ?? start;
      const before = prev.slice(0, start);
      const after  = prev.slice(end);
      const sep = before && !before.endsWith("\n") ? "\n\n" : "";
      const next = `${before}${sep}${snippet}\n${after}`;
      requestAnimationFrame(() => {
        const pos = (before + sep + snippet + "\n").length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
      return next;
    });
  }
  async function handleSubmitResponse() {
    const body = respText.trim();
    if (!body) return;
    const tid = toast.loading("Pinning response to IPFS…");
    let cid: string;
    try {
      cid = await pinText(body);
      toast.success("Pinned. Submitting…", { id: tid });
    } catch {
      toast.error("Failed to pin", { id: tid });
      return;
    }
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "respondToDispute",
        args: [meta.jobId, cid],
      },
      { pending: "Submitting response on-chain…", success: "Response submitted!", error: "Submission failed" }
    );
    setRespText("");
    await refetch();
  }

  const canRule = role === "arbitrator" && !meta.resolved && (hasResponse || windowClosed);
  const [rulingText, setRulingText] = useState("");
  const [rulingPayProvider, setRulingPayProvider] = useState(true);
  const [rulingPenalty, setRulingPenalty] = useState("20");
  const rulingRef = useRef<HTMLTextAreaElement>(null);
  function insertIntoRuling(snippet: string) {
    setRulingText(prev => {
      const ta = rulingRef.current;
      if (!ta) return `${prev}${prev ? "\n\n" : ""}${snippet}\n`;
      const start = ta.selectionStart ?? prev.length;
      const end   = ta.selectionEnd ?? start;
      const before = prev.slice(0, start);
      const after  = prev.slice(end);
      const sep = before && !before.endsWith("\n") ? "\n\n" : "";
      const next = `${before}${sep}${snippet}\n${after}`;
      requestAnimationFrame(() => {
        const pos = (before + sep + snippet + "\n").length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
      return next;
    });
  }
  async function handleResolve() {
    const body = rulingText.trim();
    if (!body) {
      toast.error("Ruling notes required");
      return;
    }
    const tid = toast.loading("Pinning ruling to IPFS…");
    let cid: string;
    try {
      cid = await pinText(body);
      toast.success("Pinned. Resolving…", { id: tid });
    } catch {
      toast.error("Failed to pin", { id: tid });
      return;
    }
    const penalty = Math.max(0, Math.min(100, Number(rulingPenalty) || 0));
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "resolveDispute",
        args: [meta.jobId, rulingPayProvider, cid, penalty],
      },
      { pending: "Resolving on-chain…", success: "Dispute resolved.", error: "Resolution failed" }
    );
    await refetch();
  }

  const canClaimDefault = !meta.resolved && !hasResponse && windowClosed;
  async function handleDefaultRuling() {
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "claimDefaultRuling",
        args: [meta.jobId],
      },
      { pending: "Claiming default ruling…", success: "Default ruling applied.", error: "Default ruling failed" }
    );
    await refetch();
  }

  const initiatorLabel  = initiatorIsPoster ? "Poster" : initiatorIsProvider ? "Provider" : "?";
  const respondentLabel = initiatorIsPoster ? "Provider" : "Poster";

  return (
    <div className="panel danger">
      <div className="panel-head">
        <span className="title">
          {meta.resolved ? "Dispute — Resolved" : "Dispute — In Progress"}
        </span>
        {!meta.resolved && (
          <span className="meta">
            {hasResponse
              ? "Awaiting arbitrator ruling"
              : windowClosed
                ? "Response window closed"
                : `Response window: ${hoursLeft}h ${minutesLeft}m left`}
          </span>
        )}
      </div>

      {/* Two-column claim vs response */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div className="sub-card">
          <div className="sub-card-head">
            <span className="label">{initiatorLabel}&apos;s claim</span>
            <span className="addr">{shortAddress(meta.disputeInitiator)}</span>
          </div>
          <IPFSMarkdownClient cid={meta.disputeReasonHash} />
        </div>

        <div className="sub-card">
          <div className="sub-card-head">
            <span className="label">{respondentLabel}&apos;s response</span>
            {hasResponse && (
              <span className="addr">
                {shortAddress(initiatorIsPoster ? meta.assignedProvider : meta.poster)}
              </span>
            )}
          </div>
          {hasResponse ? (
            <IPFSMarkdownClient cid={meta.disputeResponseHash} />
          ) : canRespond ? (
            <>
              <p style={{ fontSize: 12, color: "var(--ink-mute)", margin: "0 0 8px", lineHeight: 1.5 }}>
                You are the {respondentLabel.toLowerCase()}. Make your case — text + files are pinned to IPFS.
              </p>
              <textarea
                ref={respRef}
                className="textarea"
                value={respText}
                onChange={e => setRespText(e.target.value)}
                placeholder="Explain your side of the dispute…"
                style={{ minHeight: 140 }}
              />
              <div style={{ marginTop: 10 }}>
                <FileAttacher onPinned={(snippet) => insertIntoResp(snippet)} />
              </div>
              <button
                type="button"
                onClick={handleSubmitResponse}
                disabled={!respText.trim()}
                className="btn btn-primary btn-big"
                style={{ marginTop: 12 }}
              >
                Submit response
              </button>
            </>
          ) : windowClosed ? (
            <p style={{ fontSize: 12, color: "var(--ink-mute)", fontStyle: "italic", margin: 0 }}>
              {respondentLabel} did not respond within the 48h window.
            </p>
          ) : role === respondentRole ? (
            <p style={{ fontSize: 12, color: "var(--ink-mute)", fontStyle: "italic", margin: 0 }}>…</p>
          ) : (
            <p style={{ fontSize: 12, color: "var(--ink-mute)", fontStyle: "italic", margin: 0 }}>
              Awaiting {respondentLabel.toLowerCase()}&apos;s response.
            </p>
          )}
        </div>
      </div>

      {/* Ruling — once resolved */}
      {meta.resolved && (
        <div className="sub-card">
          <div className="sub-card-head">
            <span className="label">Arbitrator ruling</span>
            <span className="addr">{arbitrator && shortAddress(arbitrator)}</span>
          </div>
          {meta.disputeRulingHash === "default:no-response" ? (
            <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: 0 }}>
              Default ruling — {respondentLabel} did not respond within 48h, funds awarded to {initiatorLabel.toLowerCase()}.
            </p>
          ) : (
            <IPFSMarkdownClient cid={meta.disputeRulingHash} />
          )}
        </div>
      )}

      {/* Arbitrator ruling form */}
      {canRule && (
        <div className="sub-card" style={{ borderColor: "rgba(255,205,140,0.32)" }}>
          <div className="sub-card-head">
            <span className="label" style={{ color: "var(--honey)" }}>Arbitrator: cast ruling</span>
          </div>
          {!hasResponse && windowClosed && (
            <p style={{ fontSize: 12, color: "var(--honey)", margin: "0 0 10px", lineHeight: 1.5 }}>
              No response received within 48h. You may resolve in favor of the initiator,
              or anyone can trigger the default ruling below.
            </p>
          )}
          <textarea
            ref={rulingRef}
            className="textarea"
            value={rulingText}
            onChange={e => setRulingText(e.target.value)}
            placeholder="Ruling notes — required. Reference both sides' arguments."
            style={{ minHeight: 120 }}
          />
          <div style={{ marginTop: 10 }}>
            <FileAttacher onPinned={(snippet) => insertIntoRuling(snippet)} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-soft)", cursor: "pointer" }}>
              <input
                type="radio"
                name="ruling"
                checked={rulingPayProvider}
                onChange={() => setRulingPayProvider(true)}
                style={{ accentColor: "var(--green)" }}
              />
              Pay provider
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-soft)", cursor: "pointer" }}>
              <input
                type="radio"
                name="ruling"
                checked={!rulingPayProvider}
                onChange={() => setRulingPayProvider(false)}
                style={{ accentColor: "var(--rose)" }}
              />
              Refund poster
            </label>
          </div>

          {!rulingPayProvider && meta.agentId > 0n && (
            <div style={{ marginTop: 12 }}>
              <label className="form-label">
                Reputation penalty for agent (0–100)
              </label>
              <input
                type="number"
                min="0"
                max="100"
                value={rulingPenalty}
                onChange={e => setRulingPenalty(e.target.value)}
                className="input"
              />
            </div>
          )}

          <button
            type="button"
            onClick={handleResolve}
            disabled={!rulingText.trim()}
            className="btn btn-primary btn-big"
            style={{ marginTop: 14 }}
          >
            Resolve dispute
          </button>
        </div>
      )}

      {/* Default ruling — anyone after window closed */}
      {canClaimDefault && (
        <div className="sub-card" style={{ borderColor: "rgba(255,179,106,0.32)" }}>
          <p style={{ color: "var(--amber)", fontSize: 13, margin: "0 0 10px", lineHeight: 1.5 }}>
            48h passed with no response — anyone can apply the default ruling in favor of {initiatorLabel.toLowerCase()}.
          </p>
          <button type="button" onClick={handleDefaultRuling} className="btn btn-primary btn-big">
            Claim default ruling
          </button>
        </div>
      )}
    </div>
  );
}
