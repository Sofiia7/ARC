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
};

const FULL_SEEDS: Seed[] = [
  {
    title: "Translate ArcBounty README to Spanish",
    body: "Translate `README.md` into idiomatic Spanish. Keep code blocks untouched. Submit the translated markdown.",
    category: "content", tags: ["translation", "es", "docs"], rewardUsdc: 3, days: 7, agentOnly: false,
  },
  {
    title: "Summarize 5 recent Arc Network blog posts",
    body: "Pick the 5 latest posts from blog.arc.network. Produce a 150-word summary each with key takeaways.",
    category: "content", tags: ["summary", "arc", "research"], rewardUsdc: 8, days: 5, agentOnly: true,
  },
  {
    title: "Solidity gas-golf: optimize a simple voting contract",
    body: "I will share a 60-line voting contract. Reduce gas on `vote()` by ≥20% while keeping behavior identical. Forge tests must pass.",
    category: "dev", tags: ["solidity", "gas", "foundry"], rewardUsdc: 75, days: 10, agentOnly: false,
  },
  {
    title: "Design a Twitter/X banner for ArcBounty",
    body: "1500×500 PNG, dark sunset palette matching the site. Source file (Figma/Affinity/PSD) plus the export.",
    category: "design", tags: ["banner", "branding", "x"], rewardUsdc: 40, days: 6, agentOnly: false,
  },
  {
    title: "Write a TypeScript snippet: pin a Buffer to Pinata v3",
    body: "20–40 line example. Must use `network: public` and return `{ cid, size }`. MIT-licensed.",
    category: "dev", tags: ["typescript", "ipfs", "pinata"], rewardUsdc: 15, days: 4, agentOnly: true,
  },
  {
    title: "Scrape & dedupe ETH-related job postings (CSV, 200 rows)",
    body: "Source: 3 public job boards of your choice. Columns: title, company, url, posted_at, location. Submit `.csv` pinned to IPFS.",
    category: "data", tags: ["scrape", "csv", "jobs"], rewardUsdc: 25, days: 7, agentOnly: true,
  },
  {
    title: "Record a 60-second screencast walkthrough of /post page",
    body: "Show: connect wallet → write description → attach image → set reward → post. MP4, 1080p.",
    category: "content", tags: ["video", "demo", "walkthrough"], rewardUsdc: 30, days: 5, agentOnly: false,
  },
  {
    title: "Find a critical bug in BountyAdapter.sol",
    body: "Read `contracts/src/BountyAdapter.sol`. Submit a PoC + Foundry test reproducing any *medium-or-higher* severity issue. Triage by adapter owner.",
    category: "other", tags: ["audit", "solidity", "security"], rewardUsdc: 150, days: 14, agentOnly: false,
  },
  {
    title: "Compile a list of 50 Arc Testnet contracts with activity",
    body: "Use the explorer. Output JSON: `[{address, name?, tx_count_7d, first_seen}]`. Highest activity first.",
    category: "data", tags: ["onchain", "arc", "json"], rewardUsdc: 20, days: 6, agentOnly: true,
  },
  {
    title: "Write a 600-word blog post: \"Why agents need a bounty board\"",
    body: "Casual tone. Reference ERC-8183 + ERC-8004. Submit markdown + 1 hero illustration (your choice).",
    category: "content", tags: ["blog", "agents", "erc-8004"], rewardUsdc: 50, days: 8, agentOnly: false,
  },
];

// Resolve which subset to post. SEED_LIMIT clamps the count, SEED_MIN_REWARD overrides
// rewards down to a fixed minimum (useful when seed wallet is low on testnet USDC).
const LIMIT = Number(process.env.SEED_LIMIT ?? FULL_SEEDS.length);
const MIN_REWARD = process.env.SEED_MIN_REWARD ? Number(process.env.SEED_MIN_REWARD) : null;
const SEEDS: Seed[] = FULL_SEEDS.slice(0, LIMIT).map(s =>
  MIN_REWARD !== null ? { ...s, rewardUsdc: MIN_REWARD } : s
);

async function pinDescription(seed: Seed): Promise<string> {
  const md = `# ${seed.title}\n\n${seed.body}\n\n_Posted by ArcBounty seed script — demo bounty._\n`;
  const blob = new Blob([md], { type: "text/markdown" });
  const form = new FormData();
  form.append("file", blob, `${seed.title.slice(0, 40).replace(/\W+/g, "-")}.md`);
  form.append("network", "public");
  const res = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Pinata ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json() as { data: { cid: string } };
  return `ipfs://${data.data.cid}`;
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
        humanOnly:    false,
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
