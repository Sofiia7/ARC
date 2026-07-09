"use client";

import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import { fetchIpfsText } from "@/lib/ipfs";

type Props = { cid: string };

const GATEWAY = "https://ipfs.io/ipfs/";

/**
 * rehype-sanitize schema:
 *  - href / src only from http(s), ipfs, mailto.
 *  - no <script>, no on*, no <iframe>, no <object>, etc.
 *  - <a> may carry target/rel (we always force noopener noreferrer below).
 */
const SCHEMA: Schema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "ipfs", "mailto"],
    src:  ["http", "https", "ipfs"],
  },
  attributes: {
    ...defaultSchema.attributes,
    a:   [...(defaultSchema.attributes?.a ?? []),   ["target"], ["rel"]],
    img: [...(defaultSchema.attributes?.img ?? []), ["loading"], ["alt"], ["title"]],
  },
};

function rewriteUrl(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.startsWith("ipfs://")) return `${GATEWAY}${raw.slice(7)}`;
  return raw;
}

const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...props }) => (
    <a
      {...props}
      href={rewriteUrl(href)}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-blue-300 hover:text-blue-200 underline"
    >
      {children}
    </a>
  ),
  img: ({ node: _node, src, alt, ...props }) => (
    <img
      {...props}
      src={rewriteUrl(typeof src === "string" ? src : "")}
      alt={alt ?? ""}
      loading="lazy"
      className="my-3 rounded-lg max-w-full border border-white/10"
    />
  ),
  code: ({ children, ...props }) => (
    <code {...props} className="bg-white/10 px-1.5 py-0.5 rounded text-sm font-mono">
      {children}
    </code>
  ),
};

export function IPFSMarkdownClient({ cid }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError]     = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    fetchIpfsText(cid)
      .then(text => { if (!cancelled) setContent(text); })
      .catch(()   => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [cid, attempt]);

  if (error) {
    return (
      <p className="text-gray-400 text-sm italic">
        Failed to load from IPFS (public gateways are occasionally slow/unreachable). CID: {cid}
        {" "}
        <button
          type="button"
          onClick={() => { setContent(null); setAttempt(a => a + 1); }}
          className="text-blue-300 hover:text-blue-200 underline not-italic"
        >
          Retry
        </button>
      </p>
    );
  }
  if (content === null)
    return <div className="h-16 bg-white/5 border border-white/10 rounded animate-pulse" />;

  return (
    <div className="prose prose-invert prose-sm max-w-none text-gray-100 leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, SCHEMA]]}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
