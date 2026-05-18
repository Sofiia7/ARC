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
      className={`flex items-center gap-3 rounded-xl border border-dashed px-3 py-2.5 text-sm transition-colors ${
        dragOver ? "border-orange-400 bg-orange-500/10" : "border-white/20 bg-white/5"
      }`}
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-50 px-3 py-1.5 text-xs font-medium"
      >
        {busy ? "Uploading…" : label}
      </button>
      <span className="text-xs text-gray-300/80">
        or drag &amp; drop — pinned to IPFS, link inserted into description
      </span>
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
