/**
 * Seed the marketplace with diverse demo bounties.
 *
 * Env required:
 *   PRIVATE_KEY                — poster wallet (must hold ARC for gas + USDC for rewards)
 *   ARC_TESTNET_RPC_URL        — RPC endpoint
 *   BOUNTY_ADAPTER_ADDRESS     — current adapter
 *   PINATA_JWT                 — for IPFS description pinning
 *
 * Usage (from repo root):
 *   npx -y -p tsx -p viem@2 -p dotenv tsx scripts/seed-bounties.ts
 *   (or rely on frontend/node_modules: `cd frontend && npx tsx ../scripts/seed-bounties.ts`)
 */

import {
  createWalletClient, createPublicClient, http, parseUnits, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC      = process.env.ARC_TESTNET_RPC_URL!;
const PK       = process.env.PRIVATE_KEY as `0x${string}`;
const ADAPTER  = process.env.BOUNTY_ADAPTER_ADDRESS as Address;
const USDC     = (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as Address;
const PINATA   = process.env.PINATA_JWT!;

if (!RPC || !PK || !ADAPTER || !PINATA) {
  console.error("Missing env: ARC_TESTNET_RPC_URL / PRIVATE_KEY / BOUNTY_ADAPTER_ADDRESS / PINATA_JWT");
  process.exit(1);
}

const arc = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "Arc", symbol: "ARC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } },
} as const;

const account = privateKeyToAccount(PK);
const wallet = createWalletClient({ account, chain: arc, transport: http(RPC) });
const pub    = createPublicClient({ chain: arc, transport: http(RPC) });

const ERC20_ABI = [{
  name: "approve", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ type: "bool" }],
}, {
  name: "allowance", type: "function", stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
  outputs: [{ type: "uint256" }],
}, {
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }],
  outputs: [{ type: "uint256" }],
}] as const;

// Deployed adapter (Variant B+) uses a struct param with two trailing bools.
const ADAPTER_ABI = [{
  name: "createBounty", type: "function", stateMutability: "nonpayable",
  inputs: [{
    name: "p", type: "tuple",
    components: [
      { name: "provider",     type: "address"  },
      { name: "reward",       type: "uint256"  },
      { name: "deadline",     type: "uint256"  },
      { name: "ipfsDescHash", type: "string"   },
      { name: "category",     type: "string"   },
      { name: "tags",         type: "string[]" },
      { name: "agentOnly",    type: "bool"     },
      { name: "humanOnly",    type: "bool"     },
    ],
  }],
  outputs: [{ name: "jobId", type: "uint256" }],
}] as const;

type Seed = {
  title: string;
  body: string;
  category: string;
  tags: string[];
  rewardUsdc: number;
  days: number;
  agentOnly: boolean;
  humanOnly?: boolean;
};

// The first 8 entries are intentionally ordered to cover ALL five categories
// with a mix of open / agentOnly / humanOnly audiences — so a default
// SEED_LIMIT=8 run already populates every filter on the frontend. The rest
// fill out 2–4 per category and post automatically once the wallet has more
// USDC (raise SEED_LIMIT).
const FULL_SEEDS: Seed[] = [
  // ── Priority 8 (balanced across categories + audiences) ──────────────────
  {
    title: "viem script: watch BountyCreated and print new bounties",
    body: "Write a ~40-line TypeScript script using `viem` `watchContractEvent` that subscribes to `BountyCreated` on the adapter and logs `{ jobId, reward, category }` for each. MIT-licensed, runnable with tsx.",
    category: "dev", tags: ["typescript", "viem", "events"], rewardUsdc: 1, days: 10, agentOnly: false,
  },
  {
    title: "TypeScript snippet: pin a Buffer to Pinata v3",
    body: "20–40 line example. Must use `network: public` and return `{ cid, size }`. MIT-licensed. Submit as a gist or markdown.",
    category: "dev", tags: ["typescript", "ipfs", "pinata"], rewardUsdc: 1, days: 4, agentOnly: true,
  },
  {
    title: "Design a Twitter/X banner for ArcBounty",
    body: "1500×500 PNG, dark sunset palette matching the site. Submit the source file (Figma/Affinity/PSD) plus the PNG export, pinned to IPFS.",
    category: "design", tags: ["banner", "branding", "x"], rewardUsdc: 1, days: 6, agentOnly: false,
  },
  {
    title: "Figma wireframe for a disputes dashboard",
    body: "Low-fi wireframe of a page listing active disputes with claim/response/ruling columns and a countdown. Submit a shareable Figma link + PNG. Human designers only.",
    category: "design", tags: ["figma", "wireframe", "ux"], rewardUsdc: 1, days: 8, agentOnly: false, humanOnly: true,
  },
  {
    title: "Translate ArcBounty README to Spanish",
    body: "Translate `README.md` into idiomatic Spanish. Keep code blocks untouched. Submit the translated markdown.",
    category: "content", tags: ["translation", "es", "docs"], rewardUsdc: 1, days: 7, agentOnly: false,
  },
  {
    title: "Summarize 5 recent Arc Network blog posts",
    body: "Pick the 5 latest posts from blog.arc.network. Produce a 150-word summary each with key takeaways. Submit as markdown.",
    category: "content", tags: ["summary", "arc", "research"], rewardUsdc: 1, days: 5, agentOnly: true,
  },
  {
    title: "Scrape & dedupe ETH-related job postings (CSV, 200 rows)",
    body: "Source: 3 public job boards of your choice. Columns: title, company, url, posted_at, location. Submit `.csv` pinned to IPFS.",
    category: "data", tags: ["scrape", "csv", "jobs"], rewardUsdc: 1, days: 7, agentOnly: true,
  },
  {
    title: "Find a medium+ severity bug in BountyAdapter.sol",
    body: "Read `contracts/src/BountyAdapter.sol`. Submit a PoC + Foundry test reproducing any *medium-or-higher* severity issue. Triaged by the adapter owner. Human researchers only.",
    category: "other", tags: ["audit", "solidity", "security"], rewardUsdc: 1, days: 14, agentOnly: false, humanOnly: true,
  },

  // ── Overflow (post when the wallet has more USDC; raise SEED_LIMIT) ───────
  {
    title: "Solidity gas-golf: optimize a simple voting contract",
    body: "I will share a 60-line voting contract. Reduce gas on `vote()` by ≥20% while keeping behavior identical. Forge tests must pass.",
    category: "dev", tags: ["solidity", "gas", "foundry"], rewardUsdc: 1, days: 10, agentOnly: false,
  },
  {
    title: "Design an agent-profile avatar set (10 SVGs)",
    body: "10 generative-style SVG avatars for ERC-8004 agent profiles, sunset palette. Submit a zip pinned to IPFS, MIT-licensed.",
    category: "design", tags: ["svg", "avatars", "branding"], rewardUsdc: 1, days: 6, agentOnly: false,
  },
  {
    title: "Write a 600-word blog post: \"Why agents need a bounty board\"",
    body: "Casual tone. Reference ERC-8183 + ERC-8004. Submit markdown + 1 hero illustration (your choice).",
    category: "content", tags: ["blog", "agents", "erc-8004"], rewardUsdc: 1, days: 8, agentOnly: false,
  },
  {
    title: "Compile a list of 50 Arc Testnet contracts with activity",
    body: "Use the explorer. Output JSON: `[{address, name?, tx_count_7d, first_seen}]`. Highest activity first.",
    category: "data", tags: ["onchain", "arc", "json"], rewardUsdc: 1, days: 6, agentOnly: true,
  },
  {
    title: "Build a 30-day USDC price dataset (CSV)",
    body: "Daily open/high/low/close for USDC from any public API, last 30 days. Submit `.csv` + a one-line provenance note.",
    category: "data", tags: ["dataset", "csv", "price"], rewardUsdc: 1, days: 5, agentOnly: true,
  },
  {
    title: "Propose 3 new bounty categories with rationale",
    body: "Short markdown: 3 proposed categories beyond dev/design/content/data/other, each with 2–3 example bounties and why it fits Arc's agent economy.",
    category: "other", tags: ["product", "proposal", "community"], rewardUsdc: 1, days: 7, agentOnly: false,
  },
];

// Resolve which subset to post. SEED_OFFSET skips the first N entries (resume a
// partial run), SEED_LIMIT clamps the end index, SEED_MIN_REWARD overrides
// rewards down to a fixed minimum (useful when seed wallet is low on testnet USDC).
// SEED_DEADLINE_DAYS overrides every entry's deadline — Arc testnet's block.timestamp
// advances far faster than real time, so the short 4-14 day deadlines below can
// already be expired within an hour of real-world demo time; use a large override
// (e.g. 60) when seeding data meant to stay browsable for a live demo.
const OFFSET = Number(process.env.SEED_OFFSET ?? 0);
const LIMIT = Number(process.env.SEED_LIMIT ?? FULL_SEEDS.length);
const MIN_REWARD = process.env.SEED_MIN_REWARD ? Number(process.env.SEED_MIN_REWARD) : null;
const DEADLINE_DAYS = process.env.SEED_DEADLINE_DAYS ? Number(process.env.SEED_DEADLINE_DAYS) : null;
const SEEDS: Seed[] = FULL_SEEDS.slice(OFFSET, LIMIT).map(s => ({
  ...s,
  ...(MIN_REWARD !== null ? { rewardUsdc: MIN_REWARD } : {}),
  ...(DEADLINE_DAYS !== null ? { days: DEADLINE_DAYS } : {}),
}));

async function pinDescription(seed: Seed): Promise<string> {
  const md = `# ${seed.title}\n\n${seed.body}\n\n_Posted by ArcBounty seed script — demo bounty._\n`;
  const blob = new Blob([md], { type: "text/markdown" });
  const form = new FormData();
  form.append("file", blob, `${seed.title.slice(0, 40).replace(/\W+/g, "-")}.md`);
  // v2 pinning API — a JWT scoped for `pinFileToIPFS` authenticates via Bearer.
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Pinata ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json() as { IpfsHash: string };
  return `ipfs://${data.IpfsHash}`;
}

async function ensureAllowance(total: bigint) {
  const cur = await pub.readContract({
    address: USDC, abi: ERC20_ABI, functionName: "allowance",
    args: [account.address, ADAPTER],
  });
  if (cur >= total) {
    console.log(`Allowance OK: ${cur} ≥ ${total}`);
    return;
  }
  console.log(`Approving USDC ${total} → adapter…`);
  const hash = await wallet.writeContract({
    address: USDC, abi: ERC20_ABI, functionName: "approve",
    args: [ADAPTER, total],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  approve tx: ${hash}`);
}

async function main() {
  console.log("Seeder address:", account.address);
  const usdcBal = await pub.readContract({
    address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
  console.log(`USDC balance: ${Number(usdcBal) / 1e6}`);

  const total = SEEDS.reduce((a, s) => a + parseUnits(String(s.rewardUsdc), 6), 0n);
  if (usdcBal < total) {
    throw new Error(`Insufficient USDC: have ${Number(usdcBal)/1e6}, need ${Number(total)/1e6}`);
  }
  await ensureAllowance(total);

  const ZERO = "0x0000000000000000000000000000000000000000" as Address;
  const results: { jobIdLog: string; title: string; tx: string }[] = [];

  for (const [i, s] of SEEDS.entries()) {
    console.log(`\n[${i + 1}/${SEEDS.length}] ${s.title}`);
    const cid = await pinDescription(s);
    console.log(`  pinned: ${cid}`);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + s.days * 86400);
    const reward   = parseUnits(String(s.rewardUsdc), 6);
    const hash = await wallet.writeContract({
      address: ADAPTER, abi: ADAPTER_ABI, functionName: "createBounty",
      args: [{
        provider:     ZERO,
        reward,
        deadline,
        ipfsDescHash: cid,
        category:     s.category,
        tags:         s.tags,
        agentOnly:    s.agentOnly,
        humanOnly:    s.humanOnly ?? false,
      }],
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    console.log(`  tx: ${hash} status=${rcpt.status}`);
    results.push({ jobIdLog: rcpt.logs[0]?.topics?.[1] ?? "?", title: s.title, tx: hash });
  }

  console.log("\nSeeded:");
  for (const r of results) console.log(`  ${r.title} — ${r.tx}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
