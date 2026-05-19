"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { useTx } from "@/hooks/useTx";
import { pinText } from "@/lib/ipfs";
import { FileAttacher } from "./FileAttacher";

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
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-red-900/60 rounded-2xl p-6 w-full max-w-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-red-200">Propose rejection</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>
        <p className="text-sm text-gray-300 mb-3">
          Explain why the submitted work doesn&apos;t meet the bounty. Your reason is pinned to
          IPFS so the worker can see it. The worker has <strong>48 hours</strong> to challenge.
          If they don&apos;t — anyone can finalize the rejection and your USDC is refunded.
        </p>
        <textarea
          ref={ref}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="What's missing? What was promised vs delivered? Be specific."
          rows={8}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl p-3 text-sm resize-none focus:outline-none focus:border-red-500 font-mono"
        />
        <div className="mt-2">
          <FileAttacher onPinned={(snippet) => insertSnippet(snippet)} />
        </div>
        <div className="flex gap-3 mt-4">
          <button
            onClick={onClose}
            className="flex-1 bg-gray-800 hover:bg-gray-700 py-2.5 rounded-xl text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleReject}
            disabled={!text.trim() || busy}
            className="flex-1 bg-red-700 hover:bg-red-600 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed py-2.5 rounded-xl text-sm font-semibold transition-colors"
          >
            {busy ? "Proposing…" : "Propose rejection"}
          </button>
        </div>
      </div>
    </div>
  );
}
