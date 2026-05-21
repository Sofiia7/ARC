"use client";

/**
 * Parses markdown text for image links of the form
 *
 *   ![name](ipfs://CID)
 *
 * and renders each one as a small thumbnail tile so the user can verify
 * what they actually attached, instead of staring at raw IPFS URIs.
 *
 * Falls back gracefully: non-image attachments (PDFs, .md, …) show as
 * a generic file pill with the name and a "open ↗" link.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

type Attachment = {
  kind: "image" | "file";
  name: string;
  cid: string; // bare CID (no ipfs:// prefix)
};

function parse(text: string): Attachment[] {
  const out: Attachment[] = [];
  const seen = new Set<string>();
  const linkRe = /(!?)\[([^\]]+)\]\((ipfs:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text)) !== null) {
    const isImageSyntax = m[1] === "!";
    const name = m[2]!;
    const uri  = m[3]!;
    if (seen.has(uri)) continue;
    seen.add(uri);
    const cid = uri.replace(/^ipfs:\/\//, "");
    const looksLikeImage = isImageSyntax || IMAGE_EXT.test(name);
    out.push({ kind: looksLikeImage ? "image" : "file", name, cid });
  }
  return out;
}

export function AttachmentPreview({ text }: { text: string }) {
  const attachments = parse(text);
  if (attachments.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        marginTop: 4,
      }}
    >
      {attachments.map(att => (
        <a
          key={att.cid}
          href={`https://gateway.pinata.cloud/ipfs/${att.cid}`}
          target="_blank"
          rel="noopener noreferrer"
          title={att.name}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: 8,
            borderRadius: 12,
            background: "var(--g-bg)",
            border: "1px solid var(--g-border)",
            backdropFilter: "var(--g-blur)",
            WebkitBackdropFilter: "var(--g-blur)",
            textDecoration: "none",
            color: "inherit",
            transition: "background 160ms ease, border-color 160ms ease",
            maxWidth: 200,
          }}
        >
          {att.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://gateway.pinata.cloud/ipfs/${att.cid}`}
              alt={att.name}
              style={{
                width: "100%",
                maxWidth: 184,
                height: 120,
                objectFit: "cover",
                borderRadius: 8,
                background: "rgba(255,255,255,0.04)",
                display: "block",
              }}
            />
          ) : (
            <div
              style={{
                width: 184,
                height: 120,
                borderRadius: 8,
                background: "rgba(255,255,255,0.04)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--ink-mute)",
                fontSize: 32,
              }}
            >
              📄
            </div>
          )}
          <span
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              color: "var(--ink-soft)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 184,
            }}
          >
            {att.name}
          </span>
        </a>
      ))}
    </div>
  );
}
