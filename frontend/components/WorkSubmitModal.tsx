"use client";

import { useRef, useState } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import { toast } from "sonner";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { pinText } from "@/lib/ipfs";
import { FileAttacher } from "./FileAttacher";

type Props = {
  jobId: bigint;
  onSuccess?: () => void;
  onClose: () => void;
};

export function WorkSubmitModal({ jobId, onSuccess, onClose }: Props) {
  const [text, setText] = useState("");
  const [step, setStep] = useState<"idle" | "pinning" | "submitting" | "done">("idle");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  function insertSnippet(snippet: string) {
    setText(prev => {
      const ta = textareaRef.current;
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

  async function handleSubmit() {
    const body = text.trim();
    if (!body) return;
    try {
      setStep("pinning");
      const tid = toast.loading("Uploading result to IPFS…");
      const cid = await pinText(body);
      toast.success("Uploaded to IPFS!", { id: tid });

      setStep("submitting");
      const tid2 = toast.loading("Submitting on-chain…");
      const hash = await writeContractAsync({
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI,
        functionName: "submitWork",
        args: [jobId, cid],
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      toast.success("Work submitted! Waiting for approval.", { id: tid2 });

      setStep("done");
      onSuccess?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg.includes("User rejected") ? "Transaction rejected" : "Submission failed");
      setStep("idle");
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Submit Work</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {step === "done" ? (
          <div className="text-center py-6">
            <div className="text-4xl mb-2">✅</div>
            <p className="text-green-400 font-semibold">Work submitted on-chain!</p>
            <p className="text-sm text-gray-400 mt-1">Waiting for poster approval.</p>
            <button onClick={onClose} className="mt-4 bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm">
              Close
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-400 mb-3">
              Paste your result, or attach files / images. Everything is pinned to IPFS, then submitted on-chain.
            </p>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Paste your result, link, or description here…"
              rows={8}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl p-3 text-sm resize-none
                         focus:outline-none focus:border-blue-500 font-mono"
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
                onClick={handleSubmit}
                disabled={!text.trim() || step !== "idle"}
                className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500
                           py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:cursor-not-allowed"
              >
                {step === "pinning"    ? "Uploading…"
                : step === "submitting" ? "Submitting…"
                :                        "Submit Work"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
