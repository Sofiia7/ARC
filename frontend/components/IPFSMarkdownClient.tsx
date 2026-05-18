"use client";

import { useEffect, useState } from "react";
import { fetchIpfsText } from "@/lib/ipfs";

type Props = { cid: string };

export function IPFSMarkdownClient({ cid }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sanitise: bounty creators sometimes pass placeholder/fake CIDs like
  // "ipfs://QmSmokeTest" that don't resolve anywhere. Surface that clearly.
  const looksReal = /^(ipfs:\/\/)?[A-Za-z0-9]{20,}/.test(cid.trim());

  useEffect(() => {
    if (!cid || !looksReal) {
      setError("This bounty has no IPFS description attached (placeholder CID).");
      return;
    }
    let cancelled = false;
    fetchIpfsText(cid)
      .then(content => {
        if (cancelled) return;
        const rendered = content
          .replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold mt-4 mb-1">$1</h3>')
          .replace(/^## (.+)$/gm,  '<h2 class="text-lg font-semibold mt-5 mb-2">$1</h2>')
          .replace(/^# (.+)$/gm,   '<h1 class="text-xl font-bold mt-6 mb-3">$1</h1>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.+?)\*/g,   '<em>$1</em>')
          .replace(/`(.+?)`/g,     '<code class="bg-white/10 px-1.5 py-0.5 rounded text-sm font-mono text-violet-200">$1</code>')
          .replace(/^- (.+)$/gm,   '<li class="ml-4 list-disc">$1</li>')
          .replace(/\n\n/g,        '</p><p class="mb-3">')
          .replace(/\n/g,          "<br />");
        setHtml(`<p class="mb-3">${rendered}</p>`);
      })
      .catch(() => { if (!cancelled) setError(`Failed to fetch from any IPFS gateway. CID: ${cid}`); });
    return () => { cancelled = true; };
  }, [cid, looksReal]);

  if (error) {
    return (
      <div className="text-sm text-gray-400 italic flex items-start gap-2">
        <span className="text-amber-400">⚠</span>
        <span>{error}</span>
      </div>
    );
  }
  if (!html) {
    return (
      <div className="space-y-2">
        <div className="h-4 bg-white/5 rounded animate-pulse w-3/4" />
        <div className="h-4 bg-white/5 rounded animate-pulse w-5/6" />
        <div className="h-4 bg-white/5 rounded animate-pulse w-2/3" />
        <p className="text-xs text-gray-500 mt-2">Fetching from IPFS…</p>
      </div>
    );
  }

  return (
    <div
      className="prose prose-invert prose-sm max-w-none text-gray-200 leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
