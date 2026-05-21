"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { pinFile, markdownForPinnedFile, type PinnedFile } from "@/lib/ipfs";

type Props = {
  label?: string;
  accept?: string;
  multiple?: boolean;
  onPinned: (markdownSnippet: string, file: PinnedFile) => void;
};

export function FileAttacher({ label = "Attach file/image", accept, multiple = true, onPinned }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function handleFiles(list: FileList | File[]) {
    const files = Array.from(list);
    if (files.length === 0) return;
    setBusy(true);
    for (const f of files) {
      const tid = toast.loading(`Uploading ${f.name}…`);
      try {
        const pinned = await pinFile(f);
        toast.success(`Pinned ${pinned.name}`, { id: tid });
        onPinned(markdownForPinnedFile(pinned), pinned);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`Upload failed: ${msg}`, { id: tid });
      }
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
      }}
      className="drop"
      style={dragOver ? {
        borderColor: "rgba(255,205,140,0.70)",
        background: "rgba(255,205,140,0.08)",
        color: "var(--ink-soft)",
      } : undefined}
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="attach"
      >
        {busy ? "Uploading…" : label}
      </button>
      <span>or drag &amp; drop — pinned to IPFS, link inserted into description</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={e => e.target.files && handleFiles(e.target.files)}
      />
    </div>
  );
}
