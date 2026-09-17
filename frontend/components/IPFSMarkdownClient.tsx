"use client";

import { useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import { fetchIpfsText } from "@/lib/ipfs";

type Props = { cid: string };

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

// Through our own cached, multi-gateway-raced endpoint instead of pointing
// straight at one public gateway from the browser - see lib/ipfsServer.ts.
// A single hardcoded gateway (previously ipfs.io) means an image the poster
// can see (their own upload, likely already warm from posting) can still be
// a broken icon for the taker if that one gateway hasn't yet picked the
// content up from Pinata's DHT announcement.
function rewriteUrl(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.startsWith("ipfs://")) return `/api/ipfs/read/${raw.slice(7)}`;
  return raw;
}

// react-markdown's defaultUrlTransform lets only http(s), mailto and a few other
// schemes through, and it runs before rehype-sanitize and before COMPONENTS: every
// ipfs:// link and image in a submission reached them as "", so attachments showed
// as broken images and dead links on every bounty page. ipfs:// is rewritten to the
// read-through endpoint here; anything else still takes the default transform.
function urlTransform(url: string): string {
  return url.startsWith("ipfs://") ? rewriteUrl(url) : defaultUrlTransform(url);
}

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

// A download from the read endpoint is named after the CID, with no extension, so
// a submitted .zip would not open with a double click. When the link text is a
// file name, it rides along for the Content-Disposition header.
const FILE_NAME = /^[\w .-]{1,96}\.[A-Za-z0-9]{1,8}$/;
function withFileName(href: string, label: string): string {
  if (!href.startsWith("/api/ipfs/read/") || !FILE_NAME.test(label)) return href;
  return `${href}?filename=${encodeURIComponent(label)}`;
}

const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...props }) => (
    <a
      {...props}
      href={withFileName(rewriteUrl(href), textOf(children).trim())}
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
        urlTransform={urlTransform}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
