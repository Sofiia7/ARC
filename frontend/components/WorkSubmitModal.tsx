"use client";

import { useRef, useState } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import { toast } from "sonner";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { pinText } from "@/lib/ipfs";
import { FileAttacher } from "./FileAttacher";
import { AttachmentPreview } from "./AttachmentPreview";
import { Modal } from "./Modal";

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

  if (step === "done") {
    return (
      <Modal title="Work submitted" onClose={onClose}>
        <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
          <div style={{ fontSize: 38, marginBottom: 8 }}>✅</div>
          <p style={{ color: "var(--green)", fontWeight: 600, margin: 0 }}>
            Work submitted on-chain!
          </p>
          <p style={{ color: "var(--ink-mute)", fontSize: 13, marginTop: 6 }}>
            Waiting for poster approval.
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose} className="btn">Close</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Submit Work" onClose={onClose}>
      <p className="modal-help">
        Paste your result, or attach files / images. Everything is pinned to IPFS, then submitted on-chain.
      </p>
      <textarea
        ref={textareaRef}
        className="textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Paste your result, link, or description here…"
      />
      <FileAttacher onPinned={(snippet) => insertSnippet(snippet)} />
      <AttachmentPreview text={text} />
      <div className="modal-actions">
        <button type="button" onClick={onClose} className="btn">Cancel</button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!text.trim() || step !== "idle"}
          className="btn btn-primary"
        >
          {step === "pinning"
            ? "Uploading…"
            : step === "submitting"
              ? "Submitting…"
              : "Submit Work"}
        </button>
      </div>
    </Modal>
  );
}
