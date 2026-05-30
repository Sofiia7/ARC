// Deprecated: the original server component used `dangerouslySetInnerHTML`
// without sanitization, which is a stored-XSS vector for IPFS-sourced content.
// Use the sanitized client component instead. This shim exists only so any
// stale import doesn't silently render unsafe HTML.
//
// Removed: 2026-05 Sprint 0 (incident response).
export { IPFSMarkdownClient as IPFSMarkdown } from "./IPFSMarkdownClient";
