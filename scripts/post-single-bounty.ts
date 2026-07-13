/**
 * One-off: post a single bond-required demo bounty (dev category), in the
 * style of scripts/seed-extra.ts but for exactly one listing instead of a batch.
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
  anonymous: false,
}, {
  name: "BountyCreated", type: "event",
  inputs: [
    { name: "jobId", type: "uint256", indexed: true },
    { name: "poster", type: "address", indexed: true },
    { name: "reward", type: "uint256", indexed: false },
    { name: "category", type: "string", indexed: false },
    { name: "deadline", type: "uint256", indexed: false },
  ],
}] as const;

const TITLE = "viem script: fetch a bounty's on-chain lifecycle timeline";
const BODY =
  "Write a ~40-line TypeScript script using `viem` that takes a `jobId` and " +
  "prints its lifecycle as a timestamp-ordered timeline by reading " +
  "`BountyCreated`, `BountyTaken`, `WorkSubmitted`, and " +
  "`BountyApproved`/`BountyDisputed` events (whichever occurred) from the " +
  "adapter, e.g.:\n\n" +
  "```\n2026-07-10T09:00Z created  reward=2.00 USDC category=dev\n" +
  "2026-07-10T09:04Z taken     by=0x6543...6115\n" +
  "2026-07-10T09:41Z submitted result=ipfs://Qm...\n" +
  "2026-07-10T10:02Z approved\n```\n\n" +
  "MIT-licensed, runnable with `tsx`. Env: `ARC_RPC_URL` (optional), " +
  "`BOUNTY_ADAPTER_ADDRESS` (required), `JOB_ID` (required).";
const CATEGORY = "dev" as const;
const TAGS = ["viem", "typescript", "events"];
const REWARD_USDC = 2;
const DAYS = 30; // generous margin — Arc testnet's clock runs faster than real time
const AGENT_ONLY = true;
const REQUIRE_WORKER_BOND = true;

async function pinDescription(): Promise<string> {
  const md = `# ${TITLE}\n\n${BODY}\n\n_Posted by ArcBounty seed script — demo bounty._\n`;
  const blob = new Blob([md], { type: "text/markdown" });
  const form = new FormData();
  form.append("file", blob, `${TITLE.slice(0, 40).replace(/\W+/g, "-")}.md`);
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
  const reward = parseUnits(String(REWARD_USDC), 6);
  await ensureAllowance(reward);

  const cid = await pinDescription();
  console.log(`Pinned description: ${cid}`);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + DAYS * 86400);
  const hash = await wallet.writeContract({
    address: ADAPTER, abi: ADAPTER_ABI, functionName: "createBounty",
    args: [{
      provider:     "0x0000000000000000000000000000000000000000" as Address,
      reward,
      deadline,
      ipfsDescHash: cid,
      category:     CATEGORY,
      tags:         TAGS,
      agentOnly:    AGENT_ONLY,
      humanOnly:    false,
      requireWorkerBond: REQUIRE_WORKER_BOND,
    }],
  });
  console.log(`createBounty tx: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`status: ${receipt.status}`);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ADAPTER.toLowerCase()) continue;
    console.log("log topics:", log.topics);
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
