"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Address } from "viem";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { useTx } from "@/hooks/useTx";
import { pinText } from "@/lib/ipfs";
import { shortAddress } from "@/lib/format";
import { IPFSMarkdownClient } from "./IPFSMarkdownClient";
import { FileAttacher } from "./FileAttacher";
import type { BountyMeta } from "./BountyCard";

const CHALLENGE_WINDOW = 48n * 3600n;

export function PendingRejectionPanel({
  meta,
  address,
  refetch,
}: {
  meta: BountyMeta;
  address: Address | undefined;
  refetch: () => void | Promise<unknown>;
}) {
  const { send } = useTx();
  const isWorker = address?.toLowerCase() === meta.assignedProvider.toLowerCase();

  const challengeDeadline = meta.rejectedAt + CHALLENGE_WINDOW;
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const t = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(t);
  }, []);
  const windowClosed = now > challengeDeadline;
  const secondsLeft = challengeDeadline > now ? Number(challengeDeadline - now) : 0;
  const hoursLeft = Math.floor(secondsLeft / 3600);
  const minutesLeft = Math.floor((secondsLeft % 3600) / 60);

  // ── Worker challenge form ──
  const canChallenge = isWorker && !windowClosed;
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  function insertSnippet(snippet: string) {
    setText(prev => {
      const ta = taRef.current;
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

  async function handleChallenge() {
    const body = text.trim();
    if (!body) return;
    const tid = toast.loading("Pinning your response to IPFS…");
    let cid: string;
    try {
      cid = await pinText(body);
      toast.success("Pinned. Opening dispute…", { id: tid });
    } catch {
      toast.error("Failed to pin", { id: tid });
      return;
    }
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "challengeRejection",
        args: [meta.jobId, cid],
      },
      { pending: "Challenging rejection on-chain…", success: "Rejection challenged — arbitrator will decide.", error: "Challenge failed" }
    );
    setText("");
    await refetch();
  }

  async function handleFinalize() {
    await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "finalizeRejection",
        args: [meta.jobId],
      },
      { pending: "Finalizing rejection…", success: "Rejection finalized. USDC refunded to poster.", error: "Finalize failed" }
    );
    await refetch();
  }

  return (
    <div className="border border-amber-900/50 bg-amber-950/20 rounded-xl p-5 mb-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-amber-200 uppercase tracking-widest">
          Rejection proposed
        </h2>
        <span className="text-xs text-amber-300/80 font-mono">
          {windowClosed
            ? "Challenge window closed"
            : `Challenge window: ${hoursLeft}h ${minutesLeft}m left`}
        </span>
      </div>

      <div className="bg-black/30 border border-white/10 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-widest">
            Poster&apos;s reason
          </h3>
          <span className="text-xs text-gray-500 font-mono">{shortAddress(meta.poster)}</span>
        </div>
        <div className="text-sm">
          <IPFSMarkdownClient cid={meta.rejectionReasonHash} />
        </div>
      </div>

      {canChallenge ? (
        <div className="bg-black/30 border border-red-900/40 rounded-lg p-4 space-y-3">
          <h3 className="text-xs font-semibold text-red-200 uppercase tracking-widest">
            Your challenge
          </h3>
          <p className="text-xs text-gray-300">
            If you disagree, write your side and submit. This opens a dispute and forces an
            arbitrator to decide — neither side can unilaterally claim the USDC anymore.
          </p>
          <textarea
            ref={taRef}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Why is the poster's rejection wrong? Reference your submission, requirements, etc."
            rows={6}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2 text-sm font-mono resize-none focus:outline-none focus:border-red-500"
          />
          <FileAttacher onPinned={(snippet) => insertSnippet(snippet)} />
          <button
            onClick={handleChallenge}
            disabled={!text.trim()}
            className="w-full bg-red-700 hover:bg-red-600 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white text-sm font-semibold py-2 rounded-lg transition-colors"
          >
            Challenge rejection
          </button>
        </div>
      ) : isWorker && windowClosed ? (
        <p className="text-xs text-gray-400 italic">
          The 48h challenge window has closed. The rejection will be finalized when anyone calls finalize.
        </p>
      ) : !isWorker && !windowClosed ? (
        <p className="text-xs text-gray-400 italic">
          Waiting for the worker to either accept the rejection (silence) or challenge it.
        </p>
      ) : null}

      {windowClosed && (
        <div className="bg-black/30 border border-amber-900/40 rounded-lg p-4 text-sm space-y-2">
          <p className="text-amber-200">
            48h passed with no challenge — anyone can finalize the rejection and refund the poster.
          </p>
          <button
            onClick={handleFinalize}
            className="w-full bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold py-2 rounded-lg transition-colors"
          >
            Finalize rejection
          </button>
        </div>
      )}
    </div>
  );
}
