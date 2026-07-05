/**
 * check-consistency.ts
 *
 * Sprint 0 guard rail: catches the three recurring footguns that bit us before.
 *   1. The canonical BountyAdapter address must match across docs, env examples, and code.
 *   2. README must not advertise contract functions that do not exist in BountyAdapter.sol.
 *   3. `.env*` files (real ones, not `.example`) must not exist in the working tree.
 *
 * Run from repo root:
 *   npx tsx scripts/check-consistency.ts
 *
 * Exit code: 0 = clean, 1 = inconsistency (use as CI gate).
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, "..");

// ─── 1. Canonical address ───────────────────────────────────────────────────────
const DEPLOYMENTS = readFileSync(join(ROOT, "contracts/DEPLOYMENTS.md"), "utf8");
const CANONICAL = DEPLOYMENTS.match(/`(0x[a-fA-F0-9]{40})`/)?.[1];
if (!CANONICAL) fail("Could not extract canonical address from contracts/DEPLOYMENTS.md");

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

const errors: string[] = [];

const ADDR_RE = /0x[a-fA-F0-9]{40}/g;
const KNOWN_NON_ADAPTER = new Set([
  "0x0747EEf0706327138c69792bF28Cd525089e4583", // AgenticCommerce
  "0x8004A818BFB912233c491871b3d84c89A494BD9e", // IdentityRegistry
  "0x8004B663056A597Dffe9eCcC1965A193B7388713", // ReputationRegistry
  "0x8004Cb1BF31DAf7788923b405b754f57acEB4272", // ValidationRegistry
  "0x3600000000000000000000000000000000000000", // USDC
  "0x0000000000000000000000000000000000000000", // zero
  "0xADac7534d3fE868E28c77df5CD930f2635bcb63A", // feeRecipient (DEPLOYMENTS.md)
  "0x4892232f0dD235cC1B92a3A87fc8990553691BC6", // arbitrator Safe (DEPLOYMENTS.md)
  "0xde427f3967cc7a0BF7A9F891195760cCffC82edA", // deployer (DEPLOYMENTS.md)
]);

for (const rel of ADDR_FILES) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, "utf8");
  for (const match of text.matchAll(ADDR_RE)) {
    const a = match[0];
    if (KNOWN_NON_ADAPTER.has(a)) continue;
    if (a.toLowerCase() === "0x" + "0".repeat(40)) continue;
    if (a.toLowerCase() !== CANONICAL!.toLowerCase()) {
      errors.push(`[addr] ${rel}: stray adapter address ${a} (expected ${CANONICAL})`);
    }
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

// ─── Report ───────────────────────────────────────────────────────────────────
if (errors.length === 0) {
  console.log(`OK — canonical adapter = ${CANONICAL}`);
  process.exit(0);
}
console.error(`check-consistency: ${errors.length} issue(s)`);
for (const e of errors) console.error("  " + e);
process.exit(1);

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}
