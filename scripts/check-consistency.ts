/**
 * check-consistency.ts
 *
 * Sprint 0 guard rail: catches the recurring footguns that bit us before.
 *   1. Per network documented in contracts/DEPLOYMENTS.md, the canonical
 *      (current, non-superseded) BountyAdapter address must match across
 *      docs, env examples, and code — and any address that ISN'T a
 *      documented network's canonical adapter or a documented protocol/infra
 *      address (registries, fee recipient, arbitrator, ...) is flagged as
 *      stray (catches stale/superseded adapter references).
 *   2. README must not advertise contract functions that do not exist in
 *      BountyAdapter.sol.
 *   3. `.env*` files (real ones, not `.example`) must not exist in the
 *      working tree.
 *   4. frontend/lib/networks.ts's arc-testnet entry must exactly match
 *      agent-sdk/src/constants.ts's NETWORKS["arc-testnet"] entry, field by
 *      field — the two are deliberately separate files (frontend can't
 *      depend on the unpublished SDK) and have no other guard against
 *      silently drifting apart.
 *
 * Run from repo root:
 *   npx tsx scripts/check-consistency.ts
 *
 * Exit code: 0 = clean, 1 = inconsistency (use as CI gate), 2 = the checker
 * itself couldn't parse something it expected to (fix the checker/data).
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, "..");

const errors: string[] = [];

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const ADDR_TOKEN_RE = /0x[a-fA-F0-9]{40}/;
const ZERO_ADDRESS = "0x" + "0".repeat(40);

// ─── 1a. Parse contracts/DEPLOYMENTS.md into per-network sections ─────────────
//
// A "network section" is any `## <Name> (chain id `<digits>`)` H2 heading —
// this is deliberately generic so a future `## Arc Mainnet (chain id ...)`
// section is picked up automatically; H2 headings that don't match this
// shape (e.g. "## Updating this file after a redeploy") are skipped. Each
// section's canonical adapter is either:
//   (a) the single non-"superseded" `### BountyAdapter (...)` subsection's
//       `| Address | \`0x...\` |` row (Arc Testnet's style), or
//   (b) a flat `| BountyAdapter | \`0x...\` |` row directly in the section
//       (Base Sepolia's rehearsal-table style), whichever the section uses.

type NetworkSection = {
  name: string;
  slug: string;
  canonicalAdapter: string | null;
  canonicalError: string | null;
  /** Protocol/infra addresses (registries, fee recipient, arbitrator, ...)
   *  legitimately referenced for this network — everything in the section's
   *  table rows EXCEPT the per-version `| Address | ... |` rows (those are
   *  adapter addresses, handled via canonicalAdapter so superseded ones stay
   *  correctly un-allowlisted). Lowercased. */
  knownAddresses: Set<string>;
};

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function extractCanonicalAdapter(body: string): { address: string | null; error: string | null } {
  const subHeaderRe = /^###[ \t]+BountyAdapter[ \t]*\(([^)]*)\)/gm;
  const subMatches = [...body.matchAll(subHeaderRe)];

  if (subMatches.length > 0) {
    const subs = subMatches.map((m, i) => ({
      label: m[1]!.trim(),
      start: m.index! + m[0].length,
      end: i + 1 < subMatches.length ? subMatches[i + 1]!.index! : body.length,
    }));
    const live = subs.filter(s => !/superseded/i.test(s.label));
    if (live.length !== 1) {
      return {
        address: null,
        error: `expected exactly 1 non-superseded "### BountyAdapter (...)" subsection, found ${live.length}`,
      };
    }
    const addrMatch = body.slice(live[0]!.start, live[0]!.end).match(/\|\s*Address\s*\|\s*`(0x[a-fA-F0-9]{40})`/);
    if (!addrMatch) {
      return { address: null, error: `no "| Address | \`0x...\` |" row found in its live "### BountyAdapter" subsection` };
    }
    return { address: addrMatch[1]!, error: null };
  }

  const flatMatch = body.match(/\|\s*BountyAdapter\s*\|\s*`(0x[a-fA-F0-9]{40})`/);
  if (flatMatch) return { address: flatMatch[1]!, error: null };

  return { address: null, error: null };
}

function extractKnownAddresses(body: string): Set<string> {
  const out = new Set<string>();
  // 2-column markdown table rows only: `| Field | ...value with maybe \`0x..\`... |`
  const rowRe = /^\|([^|\n]+)\|(.*)\|[ \t]*$/gm;
  for (const m of body.matchAll(rowRe)) {
    const field = m[1]!.trim();
    if (field === "Address") continue; // per-version adapter address row — not a generic "known" address
    const rest = m[2]!;
    for (const addrMatch of rest.matchAll(/`(0x[a-fA-F0-9]{40})`/g)) {
      out.add(addrMatch[1]!.toLowerCase());
    }
  }
  return out;
}

function parseNetworkSections(md: string): NetworkSection[] {
  const headerRe = /^##[ \t]+(.+)$/gm;
  const headers = [...md.matchAll(headerRe)].map(m => ({
    start: m.index!,
    end: m.index! + m[0].length,
    text: m[1]!.trim(),
  }));

  const sections: NetworkSection[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const netMatch = h.text.match(/^(.+?)\s*\(chain id\s*`(\d+)`\)/);
    if (!netMatch) continue; // not a network section
    const name = netMatch[1]!.trim();
    const bodyStart = h.end;
    const bodyEnd = i + 1 < headers.length ? headers[i + 1]!.start : md.length;
    const body = md.slice(bodyStart, bodyEnd);
    const { address, error } = extractCanonicalAdapter(body);
    sections.push({
      name,
      slug: slugify(name),
      canonicalAdapter: address,
      canonicalError: error,
      knownAddresses: extractKnownAddresses(body),
    });
  }
  return sections;
}

const DEPLOYMENTS = readFileSync(join(ROOT, "contracts/DEPLOYMENTS.md"), "utf8");
const sections = parseNetworkSections(DEPLOYMENTS);
if (sections.length === 0) {
  fail("Could not find any `## <Name> (chain id `<digits>`)` network section in contracts/DEPLOYMENTS.md");
}

// The two networks this repo actually targets (agent-sdk's NetworkName) MUST
// have a resolvable canonical adapter once documented; other sections (e.g.
// Base Sepolia — an explicit rehearsal, "NOT the frontend target") are
// best-effort and don't hard-fail the gate if they lack one.
const REQUIRED_CANONICAL_NETWORKS = new Set(["arc-testnet", "arc-mainnet"]);

// Addresses that are legitimately reusable across docs but aren't sourced
// from a DEPLOYMENTS.md network section (protocol-level / roadmap concepts
// mentioned elsewhere, e.g. ARCHITECTURE.md's ERC-8004 ValidationRegistry
// note) — kept tiny and explicit on purpose; prefer documenting a new
// address in DEPLOYMENTS.md over growing this list.
const SUPPLEMENTARY_KNOWN_ADDRESSES = new Set([
  "0x8004cb1bf31daf7788923b405b754f57aceb4272", // ValidationRegistry (ARCHITECTURE.md roadmap mention; not yet a live integration)
]);

const canonicalByNetwork = new Map<string, string>(); // slug -> lowercased address
const allKnownAddresses = new Set<string>(SUPPLEMENTARY_KNOWN_ADDRESSES);

for (const s of sections) {
  if (s.canonicalError) {
    errors.push(`[deployments] "${s.name}" section: ${s.canonicalError}`);
  } else if (s.canonicalAdapter) {
    canonicalByNetwork.set(s.slug, s.canonicalAdapter.toLowerCase());
  } else if (REQUIRED_CANONICAL_NETWORKS.has(s.slug)) {
    errors.push(`[deployments] "${s.name}" section: could not find a canonical (non-superseded) BountyAdapter address`);
  }
  for (const a of s.knownAddresses) allKnownAddresses.add(a);
}

const TESTNET_CANONICAL = canonicalByNetwork.get("arc-testnet");
if (!TESTNET_CANONICAL) {
  fail("Could not extract the canonical Arc Testnet BountyAdapter address from contracts/DEPLOYMENTS.md");
}

// ─── 1b. Every address in docs/env examples must be recognized ────────────────

const ADDR_FILES = [
  "README.md",
  "contracts/README.md",
  "frontend/README.md",
  "scripts/README.md",
  "mcp-server/README.md",
  "frontend/.env.example",
  "agent-sdk/.env.example",
  "scripts/.env.example",
  "mcp-server/.env.example",
  ".env.example",
];

for (const rel of ADDR_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, "utf8");
  for (const match of text.matchAll(new RegExp(ADDR_TOKEN_RE, "g"))) {
    const a = match[0];
    const lower = a.toLowerCase();
    if (lower === ZERO_ADDRESS) continue;
    if (allKnownAddresses.has(lower)) continue;
    if ([...canonicalByNetwork.values()].includes(lower)) continue;
    const expected = [...canonicalByNetwork.entries()].map(([slug, addr]) => `${slug}=${addr}`).join(", ");
    errors.push(`[addr] ${rel}: unrecognized address ${a} (expected a documented canonical adapter [${expected}] or a known protocol address from contracts/DEPLOYMENTS.md)`);
  }
}

// ─── 2. Phantom functions in docs ──────────────────────────────────────────────
const ADAPTER_SRC = readFileSync(join(ROOT, "contracts/src/BountyAdapter.sol"), "utf8");
const DECLARED_FNS = new Set(
  [...ADAPTER_SRC.matchAll(/function\s+([a-zA-Z_]\w*)\s*\(/g)].map(m => m[1]!),
);

const MENTIONED_FN_CANDIDATES = [
  "autoApprove",      // Sprint 0 — must not be advertised until implemented
  "getBountiesByCategory",
  "getMyBounties",
  "getAgentBounties",
];
const DOC_FILES = [
  "README.md",
  "contracts/README.md",
  "frontend/README.md",
];
for (const fn of MENTIONED_FN_CANDIDATES) {
  for (const rel of DOC_FILES) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const re = new RegExp(`\\b${fn}\\b`);
    if (re.test(text) && !DECLARED_FNS.has(fn)) {
      errors.push(`[docs] ${rel} mentions \`${fn}\` but BountyAdapter.sol does not declare it`);
    }
  }
}

// ─── 3. No real .env in the tree ──────────────────────────────────────────────
function walk(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "out" || entry === "cache" || entry === "lib") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, depth + 1));
    else if (/^\.env(\..+)?$/.test(entry) && !entry.endsWith(".example")) out.push(full);
  }
  return out;
}

const envFiles = walk(ROOT);
if (envFiles.length) {
  for (const f of envFiles) {
    errors.push(`[env]  real .env file present in tree: ${relative(ROOT, f)} — must not be committed; ensure .gitignore covers it`);
  }
}

// ─── 4. frontend/lib/networks.ts <-> agent-sdk/src/constants.ts drift guard ───
//
// The frontend deliberately keeps its OWN copy of the network map (it can't
// depend on the unpublished arcbounty-agent-sdk package — see that file's
// own header comment) — nothing else stops the two from silently drifting
// apart. Regex-based, not AST-based: both files are hand-written and small —
// an AST parser would be more robust to unrelated file reshuffling but is
// unavailable here (no TypeScript compiler API / ts-morph dependency in this
// workspace). If a field's regex ever stops matching, this fails loudly
// (exit 2) rather than silently skipping the comparison — a broken regex
// must never look like a clean pass.
//
// The regexes are applied to a SINGLE network's `"<slug>": { ... }` block,
// extracted by brace matching, not to the whole file. Matching file-wide
// (which this did while `arc-testnet` was the only static entry) silently
// starts comparing the wrong network the moment a second entry is added or
// the entries are reordered — the same first-match-wins trap DEPLOYMENTS.md
// already had.

type CrossCheckField = {
  label: string;
  re: RegExp;
  normalize?: (raw: string) => string;
};

const toDecimal = (raw: string) => String(Number(raw.replace(/_/g, "")));
const toLower = (raw: string) => raw.toLowerCase();

const CROSS_CHECK_FIELDS: CrossCheckField[] = [
  { label: "chainId", re: /chainId:\s*([\d_]+)/, normalize: toDecimal },
  { label: "rpcUrl (default)", re: /rpcUrl:.*?"([^"]+)"/ },
  { label: "explorerUrl", re: /explorerUrl:\s*"([^"]+)"/ },
  { label: "explorerApiUrl", re: /explorerApiUrl:\s*"([^"]+)"/ },
  { label: "explorerName", re: /explorerName:\s*"([^"]+)"/ },
  { label: "contracts.AGENTIC_COMMERCE", re: /AGENTIC_COMMERCE:\s*"(0x[a-fA-F0-9]{40})"/, normalize: toLower },
  { label: "contracts.IDENTITY_REGISTRY", re: /IDENTITY_REGISTRY:\s*"(0x[a-fA-F0-9]{40})"/, normalize: toLower },
  { label: "contracts.REPUTATION_REGISTRY", re: /REPUTATION_REGISTRY:\s*"(0x[a-fA-F0-9]{40})"/, normalize: toLower },
  { label: "contracts.USDC", re: /USDC:\s*"(0x[a-fA-F0-9]{40})"/, normalize: toLower },
  // Deliberately NOT comparing the canonical/default adapter address here —
  // frontend/lib/networks.ts documents that divergence as intentional
  // (arc-testnet has never had a baked-in default there).
  { label: "adapterDeployBlock", re: /adapterDeployBlock:\s*([\d_]+)n?/, normalize: toDecimal },
  // Arc pays gas in USDC, Base in ETH — copy branches on this, so a drift
  // here silently tells users to fund the wrong asset.
  { label: "nativeCurrency.symbol", re: /nativeCurrency:\s*\{\s*symbol:\s*"([^"]+)"/ },
  { label: "nativeCurrency.isUsdc", re: /isUsdc:\s*(true|false)/ },
  // The Base build ships as BaseBounty, the Arc build as ArcBounty.
  { label: "brand.name", re: /brand:\s*\{\s*name:\s*"([^"]+)"/ },
  { label: "brand.domain", re: /brand:\s*\{[^}]*domain:\s*"([^"]+)"/ },
];

/**
 * Extract a single `"<slug>": { ... }` entry from a network map by brace
 * matching, so field regexes can't leak across networks.
 */
function extractNetworkBlock(text: string, slug: string, fileLabel: string): string {
  const start = text.indexOf(`"${slug}": {`);
  if (start === -1) {
    fail(`[cross-check] Could not find the "${slug}" entry in ${fileLabel} — either the network was ` +
      `removed or the map's shape changed; update scripts/check-consistency.ts.`);
  }
  let depth = 0;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  fail(`[cross-check] Unbalanced braces while reading the "${slug}" entry in ${fileLabel}.`);
}

function extractCrossCheckField(block: string, field: CrossCheckField, fileLabel: string): string {
  const m = block.match(field.re);
  if (!m) {
    fail(`[cross-check] Could not find "${field.label}" in ${fileLabel} — the drift-check regex ` +
      `(scripts/check-consistency.ts) needs updating to match the file's current shape.`);
  }
  const raw = m[1]!;
  return field.normalize ? field.normalize(raw) : raw;
}

const SDK_CONSTANTS_PATH = join(ROOT, "agent-sdk/src/constants.ts");
const FRONTEND_NETWORKS_PATH = join(ROOT, "frontend/lib/networks.ts");

if (!existsSync(SDK_CONSTANTS_PATH) || !existsSync(FRONTEND_NETWORKS_PATH)) {
  errors.push(`[cross-check] could not find agent-sdk/src/constants.ts and/or frontend/lib/networks.ts`);
} else {
  const sdkText = readFileSync(SDK_CONSTANTS_PATH, "utf8");
  const feText = readFileSync(FRONTEND_NETWORKS_PATH, "utf8");
  // Every network both maps declare statically. Add base-mainnet here in the
  // same commit that adds it to the maps.
  const MIRRORED_NETWORKS = ["arc-testnet", "base-sepolia", "base-mainnet"];
  for (const slug of MIRRORED_NETWORKS) {
    const sdkBlock = extractNetworkBlock(sdkText, slug, "agent-sdk/src/constants.ts");
    const feBlock = extractNetworkBlock(feText, slug, "frontend/lib/networks.ts");
    for (const field of CROSS_CHECK_FIELDS) {
      const sdkVal = extractCrossCheckField(sdkBlock, field, `agent-sdk/src/constants.ts ("${slug}")`);
      const feVal = extractCrossCheckField(feBlock, field, `frontend/lib/networks.ts ("${slug}")`);
      if (sdkVal !== feVal) {
        errors.push(
          `[cross-check] ${slug} "${field.label}" drifted between the two network maps: ` +
          `agent-sdk/src/constants.ts="${sdkVal}" vs frontend/lib/networks.ts="${feVal}"`,
        );
      }
    }
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────
if (errors.length === 0) {
  const summary = [...canonicalByNetwork.entries()].map(([slug, addr]) => `${slug}=${addr}`).join(", ");
  console.log(`OK — canonical adapters: ${summary}`);
  process.exit(0);
}
console.error(`check-consistency: ${errors.length} issue(s)`);
for (const e of errors) console.error("  " + e);
process.exit(1);
