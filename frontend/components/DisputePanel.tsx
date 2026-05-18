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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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

  // ─── Response form (visible to the respondent when no response yet) ─────────
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

  // ─── Arbitrator ruling form ─────────────────────────────────────────────────
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

  // ─── Default ruling (anyone, after window closed, no response) ──────────────
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

  const initiatorLabel = initiatorIsPoster ? "Poster" : initiatorIsProvider ? "Provider" : "?";
  const respondentLabel = initiatorIsPoster ? "Provider" : "Poster";

  return (
    <div className="border border-red-900/50 bg-red-950/20 rounded-xl p-5 mb-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-red-300 uppercase tracking-widest">
          {meta.resolved ? "Dispute — Resolved" : "Dispute — In progress"}
        </h2>
        {!meta.resolved && (
          <span className="text-xs text-red-300/80 font-mono">
            {hasResponse
              ? "Awaiting arbitrator ruling"
              : windowClosed
                ? "Response window closed"
                : `Response window: ${hoursLeft}h ${minutesLeft}m left`}
          </span>
        )}
      </div>

      {/* Two-column layout: claim vs response */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Initiator claim */}
        <div className="bg-black/30 border border-white/10 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-widest">
              {initiatorLabel}&apos;s claim
            </h3>
            <span className="text-xs text-gray-500 font-mono">{shortAddress(meta.disputeInitiator)}</span>
          </div>
          <div className="text-sm">
            <IPFSMarkdownClient cid={meta.disputeReasonHash} />
          </div>
        </div>

        {/* Respondent reply */}
        <div className="bg-black/30 border border-white/10 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-widest">
              {respondentLabel}&apos;s response
            </h3>
            {hasResponse && (
              <span className="text-xs text-gray-500 font-mono">
                {shortAddress(initiatorIsPoster ? meta.assignedProvider : meta.poster)}
              </span>
            )}
          </div>
          {hasResponse ? (
            <div className="text-sm">
              <IPFSMarkdownClient cid={meta.disputeResponseHash} />
            </div>
          ) : canRespond ? (
            <div className="space-y-2">
              <p className="text-xs text-gray-400">
                You are the {respondentLabel.toLowerCase()}. Make your case — text + files are pinned to IPFS.
              </p>
              <textarea
                ref={respRef}
                value={respText}
                onChange={e => setRespText(e.target.value)}
                placeholder="Explain your side of the dispute…"
                rows={6}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2 text-sm font-mono resize-none focus:outline-none focus:border-blue-500"
              />
              <FileAttacher onPinned={(snippet) => insertIntoResp(snippet)} />
              <button
                onClick={handleSubmitResponse}
                disabled={!respText.trim()}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white text-sm font-semibold py-2 rounded-lg transition-colors"
              >
                Submit response
              </button>
            </div>
          ) : windowClosed ? (
            <p className="text-xs text-gray-500 italic">
              {respondentLabel} did not respond within the 48h window.
            </p>
          ) : role === respondentRole ? (
            <p className="text-xs text-gray-500 italic">…</p>
          ) : (
            <p className="text-xs text-gray-500 italic">Awaiting {respondentLabel.toLowerCase()}&apos;s response.</p>
          )}
        </div>
      </div>

      {/* Arbitrator ruling — show when resolved, or arbitrator-input form */}
      {meta.resolved && (
        <div className="bg-black/30 border border-white/10 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-widest">Arbitrator ruling</h3>
            <span className="text-xs text-gray-500 font-mono">{arbitrator && shortAddress(arbitrator)}</span>
          </div>
          {meta.disputeRulingHash === "default:no-response" ? (
            <p className="text-sm text-gray-300">
              Default ruling — {respondentLabel} did not respond within 48h, funds awarded to {initiatorLabel.toLowerCase()}.
            </p>
          ) : (
            <div className="text-sm">
              <IPFSMarkdownClient cid={meta.disputeRulingHash} />
            </div>
          )}
        </div>
      )}

      {canRule && (
        <div className="bg-black/30 border border-yellow-900/50 rounded-lg p-4 space-y-3">
          <h3 className="text-xs font-semibold text-yellow-300 uppercase tracking-widest">
            Arbitrator: cast ruling
          </h3>
          {!hasResponse && windowClosed && (
            <p className="text-xs text-amber-300/80">
              No response received within 48h. You may resolve in favor of the initiator,
              or anyone can trigger the default ruling below.
            </p>
          )}
          <textarea
            ref={rulingRef}
            value={rulingText}
            onChange={e => setRulingText(e.target.value)}
            placeholder="Ruling notes — required. Reference both sides' arguments."
            rows={5}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2 text-sm font-mono resize-none focus:outline-none focus:border-yellow-500"
          />
          <FileAttacher onPinned={(snippet) => insertIntoRuling(snippet)} />
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="ruling"
                checked={rulingPayProvider}
                onChange={() => setRulingPayProvider(true)}
                className="accent-green-500"
              />
              Pay provider
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="ruling"
                checked={!rulingPayProvider}
                onChange={() => setRulingPayProvider(false)}
                className="accent-red-500"
              />
              Refund poster
            </label>
          </div>
          {!rulingPayProvider && meta.agentId > 0n && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Reputation penalty for agent (0–100)
              </label>
              <input
                type="number"
                min="0"
                max="100"
                value={rulingPenalty}
                onChange={e => setRulingPenalty(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-yellow-500"
              />
            </div>
          )}
          <button
            onClick={handleResolve}
            disabled={!rulingText.trim()}
            className="w-full bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white text-sm font-semibold py-2 rounded-lg transition-colors"
          >
            Resolve dispute
          </button>
        </div>
      )}

      {canClaimDefault && (
        <div className="bg-black/30 border border-orange-900/50 rounded-lg p-4 text-sm space-y-2">
          <p className="text-orange-300">
            48h passed with no response — anyone can apply the default ruling in favor of {initiatorLabel.toLowerCase()}.
          </p>
          <button
            onClick={handleDefaultRuling}
            className="w-full bg-orange-600 hover:bg-orange-500 text-white text-sm font-semibold py-2 rounded-lg transition-colors"
          >
            Claim default ruling
          </button>
        </div>
      )}
    </div>
  );
}
