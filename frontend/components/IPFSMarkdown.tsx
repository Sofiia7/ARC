import { fetchIpfsText } from "@/lib/ipfs";

type Props = { cid: string };

// Server component — fetches and renders markdown from IPFS
export async function IPFSMarkdown({ cid }: Props) {
  let content = "";
  try {
    content = await fetchIpfsText(cid);
  } catch {
    return (
      <div className="text-gray-500 text-sm italic">
        Failed to load content from IPFS. CID: {cid}
      </div>
    );
  }

  // Simple markdown → HTML for common patterns (no heavy lib needed)
  const html = content
    .replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold mt-4 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2 class="text-lg font-semibold mt-5 mb-2">$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1 class="text-xl font-bold mt-6 mb-3">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,   '<em>$1</em>')
    .replace(/`(.+?)`/g,     '<code class="bg-gray-800 px-1 rounded text-sm font-mono">$1</code>')
    .replace(/^- (.+)$/gm,   '<li class="ml-4 list-disc">$1</li>')
    .replace(/\n\n/g,        '</p><p class="mb-3">')
    .replace(/\n/g,          "<br />");

  return (
    <div
      className="prose prose-invert prose-sm max-w-none text-gray-300 leading-relaxed"
      dangerouslySetInnerHTML={{ __html: `<p class="mb-3">${html}</p>` }}
    />
  );
}
