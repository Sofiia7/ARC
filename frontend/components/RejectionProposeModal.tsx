"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { useTx } from "@/hooks/useTx";
import { pinText } from "@/lib/ipfs";
import { FileAttacher } from "./FileAttacher";
import { Modal } from "./Modal";

type Props = {
  jobId: bigint;
  onSuccess: () => void | Promise<unknown>;
  onClose: () => void;
};

export function RejectionProposeModal({ jobId, onSuccess, onClose }: Props) {
  const { send } = useTx();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  function insertSnippet(snippet: string) {
    setText(prev => {
      const ta = ref.current;
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

  async function handleReject() {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    const tid = toast.loading("Pinning reason to IPFS…");
    let cid: string;
    try {
      cid = await pinText(body);
      toast.success("Pinned.", { id: tid });
    } catch {
      toast.error("Failed to pin", { id: tid });
      setBusy(false);
      return;
    }
    const hash = await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "rejectBounty",
        args: [jobId, cid],
      },
      {
        pending: "Proposing rejection on-chain…",
        success: "Rejection proposed. Worker has 48h to challenge.",
        error: "Submission failed",
      }
    );
    setBusy(false);
    if (hash) {
      await onSuccess();
      onClose();
    }
  }

  return (
    <Modal title="Propose rejection" onClose={onClose} danger>
      <p className="modal-help">
        Explain why the submitted work doesn&apos;t meet the bounty. Your reason is pinned to
        IPFS so the worker can see it. The worker has <strong style={{ color: "var(--ink)" }}>48 hours</strong> to challenge.
        If they don&apos;t — anyone can finalize the rejection and your USDC is refunded.
      </p>
      <textarea
        ref={ref}
        className="textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="What's missing? What was promised vs delivered? Be specific."
      />
      <FileAttacher onPinned={(snippet) => insertSnippet(snippet)} />
      <div className="modal-actions">
        <button type="button" onClick={onClose} className="btn">Cancel</button>
        <button
          type="button"
          onClick={handleReject}
          disabled={!text.trim() || busy}
          className="btn btn-danger"
        >
          {busy ? "Proposing…" : "Propose rejection"}
        </button>
      </div>
    </Modal>
  );
}
