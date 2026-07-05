/**
 * Top up open categories to ~4-5 each. Run AFTER seed-bounties.ts when the
 * marketplace needs more breadth for a demo / tester onboarding session.
 *
 * Reads the same env as seed-bounties.ts. Total reward = ~$32 by default;
 * override with SEED_LIMIT or SEED_MIN_REWARD as in the original script.
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
const wallet  = createWalletClient({ account, chain: arc, transport: http(RPC) });
const pub     = createPublicClient({ chain: arc, transport: http(RPC) });

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

// V4 adapter: CreateParams struct, including the opt-in requireWorkerBond flag.
const ADAPTER_ABI = [{
  name: "createBounty", type: "function", stateMutability: "nonpayable",
  inputs: [{
    name: "p", type: "tuple",
    components: [
      { name: "provider",          type: "address"  },
      { name: "reward",            type: "uint256"  },
      { name: "deadline",          type: "uint256"  },
      { name: "ipfsDescHash",      type: "string"   },
      { name: "category",          type: "string"   },
      { name: "tags",              type: "string[]" },
      { name: "agentOnly",         type: "bool"     },
      { name: "humanOnly",         type: "bool"     },
      { name: "requireWorkerBond", type: "bool"     },
    ],
  }],
  outputs: [{ name: "jobId", type: "uint256" }],
}] as const;

type Seed = {
  title:      string;
  body:       string;
  category:   "dev" | "design" | "content" | "data" | "other";
  tags:       string[];
  rewardUsdc: number;
  days:       number;
  agentOnly:  boolean;
  humanOnly:  boolean;
  requireWorkerBond?: boolean; // V4: worker posts max($0.50, 15% of reward), refunded at submitWork
};

const FULL_SEEDS: Seed[] = [
  // ── dev (+2) ───────────────────────────────────────────────────────────────
  {
    title: "Write a Foundry test demonstrating reentrancy guard works",
    body: "Add `BountyAdapter.reentrancy.t.sol` that proves the nonReentrant modifier blocks a malicious ERC20 callback during `approveBounty`. Test must fail without the guard, pass with it.",
    category: "dev", tags: ["foundry", "security", "test"], rewardUsdc: 5, days: 7, agentOnly: false, humanOnly: false,
    requireWorkerBond: true, // V4 showcase: proportional bond (15% of $5 = $0.75)
  },
  {
    title: "Ethers v6 → viem migration cheatsheet",
    body: "Side-by-side table of the 15 most common ethers v6 calls and their viem equivalents. Markdown, MIT-licensed.",
    category: "dev", tags: ["typescript", "viem", "ethers"], rewardUsdc: 2, days: 5, agentOnly: true, humanOnly: false,
  },

  // ── design (+3) ────────────────────────────────────────────────────────────
  {
    title: "Avatar pack: 8 abstract agent identicons (SVG)",
    body: "8 distinct geometric agent avatars, 256×256 SVG, transparent bg. Same design language. Submit one zip + previews PNG.",
    category: "design", tags: ["svg", "avatars", "branding"], rewardUsdc: 3, days: 6, agentOnly: false, humanOnly: true,
  },
  {
    title: "Infographic: how an Arc bounty flows through AC escrow",
    body: "Single-page infographic explaining create → take → submit → approve, with USDC flow arrows and AC + adapter highlighted. PNG + source.",
    category: "design", tags: ["infographic", "explainer"], rewardUsdc: 4, days: 8, agentOnly: false, humanOnly: true,
  },
  {
    title: "Empty-state illustration for /my page",
    body: "Friendly illustration to show on the My Bounties page when a user has no bounties yet. Matches the dark navy/sunrise palette. SVG.",
    category: "design", tags: ["empty-state", "illustration"], rewardUsdc: 2, days: 5, agentOnly: false, humanOnly: false,
  },

  // ── content (+1) ───────────────────────────────────────────────────────────
  {
    title: "Tutorial: build your first ArcBounty agent in 50 lines",
    body: "Walk a reader through a minimal agent using `arcbounty-agent-sdk`: register identity, pick a bounty, submit a result. Code blocks must compile.",
    category: "content", tags: ["tutorial", "sdk", "agents"], rewardUsdc: 5, days: 7, agentOnly: false, humanOnly: false,
  },

  // ── data (+4) ──────────────────────────────────────────────────────────────
  {
    title: "Dataset: 500 ENS names with avatar + bio JSON",
    body: "Pull 500 active ENS names with an `avatar` text record and `description`. Output JSON array. No PII beyond what's already public on-chain.",
    category: "data", tags: ["ens", "dataset", "json"], rewardUsdc: 3, days: 6, agentOnly: true, humanOnly: false,
  },
  {
    title: "ERC-8004 reputation event extractor",
    body: "Script that streams `FeedbackGiven` events from the Reputation Registry, normalizes them to CSV, columns: agentId, score, weight, reason, timestamp, tx.",
    category: "data", tags: ["onchain", "csv", "reputation"], rewardUsdc: 4, days: 7, agentOnly: true, humanOnly: false,
  },
  {
    title: "Compile a directory of 30 known agent operators on Arc",
    body: "List of 30 agentIds active in the last 30 days. Columns: agentId, owner, totalJobs, averageScore, link. JSON.",
    category: "data", tags: ["directory", "agents", "arc"], rewardUsdc: 2, days: 5, agentOnly: false, humanOnly: false,
  },
  {
    title: "Gas price histogram for Arc Testnet — last 24h",
    body: "Sample block gas prices every 60s for 24h, output CSV + a simple histogram PNG.",
    category: "data", tags: ["gas", "histogram", "arc"], rewardUsdc: 1, days: 4, agentOnly: true, humanOnly: false,
  },

  // ── other (+4) ─────────────────────────────────────────────────────────────
  {
    title: "Research: 3 prior-art bounty platforms vs ArcBounty",
    body: "Compare Gitcoin, Bountysource, Replit Bounties to ArcBounty across: fee, escrow model, identity, dispute UX. ~600 words + table.",
    category: "other", tags: ["research", "competitors"], rewardUsdc: 3, days: 7, agentOnly: false, humanOnly: true,
  },
  {
    title: "Suggest 5 governance parameters to surface on /admin",
    body: "Brief writeup naming 5 adapter constants worth exposing to the arbitrator (fee, response window, etc.), with rationale.",
    category: "other", tags: ["governance", "admin"], rewardUsdc: 1, days: 4, agentOnly: false, humanOnly: false,
  },
  {
    title: "Bug bounty triage: review 5 reported issues, classify severity",
    body: "I will share 5 informal user reports. Output: per-report severity (info/low/med/high/critical) + short justification.",
    category: "other", tags: ["triage", "security"], rewardUsdc: 2, days: 6, agentOnly: false, humanOnly: false,
  },
  {
    title: "Write 5 example bounty descriptions for each category",
    body: "Seed copy a poster can use as a template. 5 examples per category, ~50 words each. Markdown.",
    category: "other", tags: ["copywriting", "templates"], rewardUsdc: 2, days: 5, agentOnly: false, humanOnly: false,
  },
];

// SEED_DEADLINE_DAYS overrides every entry's deadline — Arc testnet's block.timestamp
// advances far faster than real time, so the short 4-8 day deadlines below can
// already be expired within an hour of real-world demo time; use a large override
// (e.g. 60) when seeding data meant to stay browsable for a live demo.
const LIMIT = Number(process.env.SEED_LIMIT ?? FULL_SEEDS.length);
const MIN_REWARD = process.env.SEED_MIN_REWARD ? Number(process.env.SEED_MIN_REWARD) : null;
const DEADLINE_DAYS = process.env.SEED_DEADLINE_DAYS ? Number(process.env.SEED_DEADLINE_DAYS) : null;
const SEEDS: Seed[] = FULL_SEEDS.slice(0, LIMIT).map(s => ({
  ...s,
  ...(MIN_REWARD !== null ? { rewardUsdc: MIN_REWARD } : {}),
  ...(DEADLINE_DAYS !== null ? { days: DEADLINE_DAYS } : {}),
}));

async function pinDescription(seed: Seed): Promise<string> {
  const md = `# ${seed.title}\n\n${seed.body}\n\n_Posted by ArcBounty seed-extra — demo bounty._\n`;
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
  console.log("Seeder:", account.address);
  const bal = await pub.readContract({
    address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });
  console.log(`USDC balance: ${Number(bal) / 1e6}`);

  const total = SEEDS.reduce((a, s) => a + parseUnits(String(s.rewardUsdc), 6), 0n);
  console.log(`Total reward required: ${Number(total) / 1e6} USDC across ${SEEDS.length} bounties`);
  if (bal < total) {
    throw new Error(`Insufficient USDC: have ${Number(bal)/1e6}, need ${Number(total)/1e6}`);
  }
  await ensureAllowance(total);

  const ZERO = "0x0000000000000000000000000000000000000000" as Address;
  const results: { title: string; tx: string }[] = [];

  for (const [i, s] of SEEDS.entries()) {
    const flag = s.agentOnly ? " [agentOnly]" : s.humanOnly ? " [humanOnly]" : "";
    console.log(`\n[${i + 1}/${SEEDS.length}] (${s.category}, $${s.rewardUsdc})${flag} ${s.title}`);
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
        humanOnly:    s.humanOnly,
        requireWorkerBond: s.requireWorkerBond ?? false,
      }],
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    console.log(`  tx: ${hash} status=${rcpt.status}`);
    results.push({ title: s.title, tx: hash });
  }

  console.log("\nSeeded:");
  for (const r of results) console.log(`  ${r.title} — ${r.tx}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
