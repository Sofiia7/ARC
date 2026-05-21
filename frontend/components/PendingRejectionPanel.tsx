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
import { AttachmentPreview } from "./AttachmentPreview";
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
  const secondsLeft  = challengeDeadline > now ? Number(challengeDeadline - now) : 0;
  const hoursLeft    = Math.floor(secondsLeft / 3600);
  const minutesLeft  = Math.floor((secondsLeft % 3600) / 60);

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
    <div className="panel warning">
      <div className="panel-head">
        <span className="title">Rejection proposed</span>
        <span className="meta">
          {windowClosed
            ? "Challenge window closed"
            : `Challenge window: ${hoursLeft}h ${minutesLeft}m left`}
        </span>
      </div>

      <div className="sub-card">
        <div className="sub-card-head">
          <span className="label">Poster&apos;s reason</span>
          <span className="addr">{shortAddress(meta.poster)}</span>
        </div>
        <IPFSMarkdownClient cid={meta.rejectionReasonHash} />
      </div>

      {canChallenge && (
        <div className="sub-card" style={{ borderColor: "rgba(255,140,120,0.30)" }}>
          <div className="sub-card-head">
            <span className="label" style={{ color: "#FFC9BC" }}>Your challenge</span>
          </div>
          <p style={{ fontSize: 12, color: "var(--ink-soft)", margin: "0 0 10px", lineHeight: 1.5 }}>
            If you disagree, write your side and submit. This opens a dispute and forces an
            arbitrator to decide — neither side can unilaterally claim the USDC anymore.
          </p>
          <textarea
            ref={taRef}
            className="textarea"
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Why is the poster's rejection wrong? Reference your submission, requirements, etc."
            style={{ minHeight: 140 }}
          />
          <div style={{ marginTop: 10 }}>
            <FileAttacher onPinned={(snippet) => insertSnippet(snippet)} />
          </div>
          <AttachmentPreview text={text} />
          <button
            type="button"
            onClick={handleChallenge}
            disabled={!text.trim()}
            className="btn btn-danger btn-big"
            style={{ marginTop: 12 }}
          >
            Challenge rejection
          </button>
        </div>
      )}

      {isWorker && windowClosed && (
        <p style={{ fontSize: 12, color: "var(--ink-mute)", fontStyle: "italic", margin: 0 }}>
          The 48h challenge window has closed. The rejection will be finalized when anyone calls finalize.
        </p>
      )}
      {!isWorker && !windowClosed && (
        <p style={{ fontSize: 12, color: "var(--ink-mute)", fontStyle: "italic", margin: 0 }}>
          Waiting for the worker to either accept the rejection (silence) or challenge it.
        </p>
      )}

      {windowClosed && (
        <div className="sub-card" style={{ borderColor: "rgba(255,205,140,0.30)" }}>
          <p style={{ color: "var(--honey)", fontSize: 13, margin: "0 0 10px" }}>
            48h passed with no challenge — anyone can finalize the rejection and refund the poster.
          </p>
          <button type="button" onClick={handleFinalize} className="btn btn-primary btn-big">
            Finalize rejection
          </button>
        </div>
      )}
    </div>
  );
}
