/**
 * One-off: post 2 plain (non-bond) demo bounties to restore open-listing
 * inventory on the board, in the style of scripts/seed-extra.ts.
 *
 * Reads the same env as seed-extra.ts: ARC_TESTNET_RPC_URL, PRIVATE_KEY,
 * BOUNTY_ADAPTER_ADDRESS, USDC_ADDRESS (optional), PINATA_JWT.
 */

import {
  createWalletClient, createPublicClient, http, parseUnits, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC     = process.env.ARC_TESTNET_RPC_URL!;
const PK      = process.env.PRIVATE_KEY as `0x${string}`;
const ADAPTER = process.env.BOUNTY_ADAPTER_ADDRESS as Address;
const USDC    = (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as Address;
const PINATA  = process.env.PINATA_JWT!;

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
}] as const;

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
  title: string; body: string;
  category: "dev" | "design" | "content" | "data" | "other";
  tags: string[]; rewardUsdc: number; days: number;
  agentOnly: boolean; humanOnly: boolean;
};

const SEEDS: Seed[] = [
  {
    title: "Write a 6-tweet launch thread for ArcBounty V4.4",
    body: "Cover: what ArcBounty is (ERC-8183 + ERC-8004 bounty board on Arc), the V4 worker-bond anti-squat mechanism, and a call to action to try a bounty. Plain text, one tweet per line, ~250 chars each.",
    category: "content", tags: ["twitter", "thread", "launch"], rewardUsdc: 2, days: 30,
    agentOnly: false, humanOnly: false,
  },
  {
    title: "Design an Open Graph preview image for arcbounty.app",
    body: "1200x630 PNG, dark navy/sunrise palette (matching the live site), ArcBounty wordmark + tagline. Submit the PNG pinned to IPFS plus a source file link.",
    category: "design", tags: ["og-image", "banner", "social"], rewardUsdc: 2, days: 30,
    agentOnly: false, humanOnly: false,
  },
];

async function pinDescription(seed: Seed): Promise<string> {
  const md = `# ${seed.title}\n\n${seed.body}\n\n_Posted by ArcBounty seed script — demo bounty._\n`;
  const blob = new Blob([md], { type: "text/markdown" });
  const form = new FormData();
  form.append("file", blob, `${seed.title.slice(0, 40).replace(/\W+/g, "-")}.md`);
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
    console.log(`Allowance OK: ${cur} >= ${total}`);
    return;
  }
  console.log(`Approving USDC ${total} -> adapter...`);
  const hash = await wallet.writeContract({
    address: USDC, abi: ERC20_ABI, functionName: "approve",
    args: [ADAPTER, total],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  approve tx: ${hash}`);
}

async function main() {
  console.log("Poster:", account.address);
  const total = SEEDS.reduce((a, s) => a + parseUnits(String(s.rewardUsdc), 6), 0n);
  await ensureAllowance(total);

  for (const [i, s] of SEEDS.entries()) {
    console.log(`\n[${i + 1}/${SEEDS.length}] (${s.category}, $${s.rewardUsdc}) ${s.title}`);
    const cid = await pinDescription(s);
    console.log(`  pinned: ${cid}`);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + s.days * 86400);
    const reward   = parseUnits(String(s.rewardUsdc), 6);
    const hash = await wallet.writeContract({
      address: ADAPTER, abi: ADAPTER_ABI, functionName: "createBounty",
      args: [{
        provider:     "0x0000000000000000000000000000000000000000" as Address,
        reward,
        deadline,
        ipfsDescHash: cid,
        category:     s.category,
        tags:         s.tags,
        agentOnly:    s.agentOnly,
        humanOnly:    s.humanOnly,
        requireWorkerBond: false,
      }],
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    console.log(`  tx: ${hash} status=${rcpt.status}`);
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
