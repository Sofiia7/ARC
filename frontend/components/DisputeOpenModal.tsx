"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { CONTRACTS, BOUNTY_ADAPTER_ABI } from "@/lib/contracts";
import { useTx } from "@/hooks/useTx";
import { pinText } from "@/lib/ipfs";
import { FileAttacher } from "./FileAttacher";
import { AttachmentPreview } from "./AttachmentPreview";
import { Modal } from "./Modal";

type Props = {
  jobId: bigint;
  onSuccess: () => void | Promise<unknown>;
  onClose: () => void;
};

export function DisputeOpenModal({ jobId, onSuccess, onClose }: Props) {
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

  async function handleOpen() {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    const tid = toast.loading("Pinning claim to IPFS…");
    let cid: string;
    try {
      cid = await pinText(body);
      toast.success("Pinned. Opening dispute…", { id: tid });
    } catch {
      toast.error("Failed to pin", { id: tid });
      setBusy(false);
      return;
    }
    const hash = await send(
      {
        address: CONTRACTS.BOUNTY_ADAPTER,
        abi: BOUNTY_ADAPTER_ABI as never,
        functionName: "disputeBounty",
        args: [jobId, cid],
      },
      { pending: "Opening dispute on-chain…", success: "Dispute opened.", error: "Open failed" }
    );
    setBusy(false);
    if (hash) {
      await onSuccess();
      onClose();
    }
  }

  return (
    <Modal title="Open dispute" onClose={onClose} danger>
      <p className="modal-help">
        Describe your claim. The other party has 48h to respond. Both arguments and the arbitrator&apos;s ruling are pinned to IPFS.
      </p>
      <textarea
        ref={ref}
        className="textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Explain why the submitted work does not (or does) meet the bounty requirements…"
      />
      <FileAttacher onPinned={(snippet) => insertSnippet(snippet)} />
      <AttachmentPreview text={text} />
      <div className="modal-actions">
        <button type="button" onClick={onClose} className="btn">Cancel</button>
        <button
          type="button"
          onClick={handleOpen}
          disabled={!text.trim() || busy}
          className="btn btn-danger"
        >
          {busy ? "Opening…" : "Open dispute"}
        </button>
      </div>
    </Modal>
  );
}
