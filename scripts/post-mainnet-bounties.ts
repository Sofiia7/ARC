/**
 * Post ArcBounty's own bounties on Arc mainnet from the deployer wallet. New
 * listings are appended to LISTINGS; the ones already posted are skipped.
 *
 * Unlike seed-bounties.ts (testnet demo listings), these are real tasks with
 * real USDC in escrow, so this script is run by hand and asks before sending.
 * Everything is checked first: the adapter is live and unpaused, every listing
 * passes the contract's own createBounty rules, the wallet covers the rewards
 * plus gas, and Pinata accepts the JWT.
 *
 * Posted titles are recorded in scripts/.mainnet-bounties-posted.json, so a run
 * interrupted halfway (a dead router DNS, a Pinata timeout) resumes where it
 * stopped instead of posting duplicates.
 *
 * In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   npx tsx post-mainnet-bounties.ts           checks, lists, asks for yes, posts
 *   npx tsx post-mainnet-bounties.ts --check   checks and lists only, sends nothing
 *
 * Reads PRIVATE_KEY (the poster: the deployer) and PINATA_JWT from the root .env.
 */
// First, before anything touches the network: a dead router DNS must not stop this.
import "./lib/dns-fallback.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient, createWalletClient, http, parseUnits, formatUnits, formatEther, parseEventLogs,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveNetwork } from "../agent-sdk/src/constants.js";
import { buildChain } from "./lib/network.js";

type Listing = {
  title: string;
  body: string;
  category: "dev" | "design" | "content" | "data" | "other";
  tags: string[];
  rewardUsdc: number;
  days: number;
  agentOnly?: boolean;
  humanOnly?: boolean;
};

const ADAPTER_ADDRESS = "0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D";

const LISTINGS: Listing[] = [
  {
    title: "Translate the ArcBounty README to Spanish",
    body:
      "Translate README.md from https://github.com/Sofiia7/ARC into natural, reviewed Spanish (say whether es-ES or es-419).\n\n" +
      "- Keep every code block, command, contract address and link exactly as it is.\n" +
      "- Translate headings, prose and table text.\n" +
      "- Unreviewed machine translation will be rejected.\n\n" +
      "**Submit:** one link to the translated Markdown file (IPFS, a public gist or a repo fork).",
    category: "content",
    tags: ["translation", "es", "docs"],
    rewardUsdc: 2,
    days: 10,
  },
  {
    title: "Design the \"ArcBounty is live on Arc mainnet\" banner",
    body:
      "Create two images announcing that ArcBounty is live on Arc mainnet:\n\n" +
      "- an X header, 1500x500\n" +
      "- a post image, 1200x675\n\n" +
      "Match the site at https://arcbounty.app (dark background, honey accent #f0b429) and use the line " +
      "\"AI agents and humans compete for the same USDC bounties\".\n\n" +
      "**Submit:** one link containing both PNGs plus the editable source (Figma link or SVG).",
    category: "design",
    tags: ["banner", "branding", "x"],
    rewardUsdc: 3,
    days: 10,
    humanOnly: true,
  },
  {
    title: "viem script: stream new ArcBounty bounties on Arc mainnet",
    body:
      "A TypeScript script of about 60 lines that uses viem to watch `BountyCreated` on the ArcBounty adapter " +
      `\`${ADAPTER_ADDRESS}\` on Arc mainnet (chain id 5042, RPC https://rpc.blockdaemon.mainnet.arc.io).\n\n` +
      "- Print jobId, poster, reward in USDC (6 decimals) and the deadline as an ISO date.\n" +
      "- Runs with `npx tsx watch.ts` and survives an RPC reconnect.\n\n" +
      "**Submit:** a gist or IPFS link with the script and one output line from a real event.",
    category: "dev",
    tags: ["typescript", "viem", "arc"],
    rewardUsdc: 2,
    days: 7,
  },
  {
    title: "Summarize the Arc mainnet launch for builders",
    body:
      "In 5 to 8 bullet points, summarize what launched with Arc mainnet on 2026-09-16 that matters to someone " +
      "building on it: network parameters, USDC as gas, what is live (CCTP, Gateway, DeFi markets, developer tools) " +
      "and what is not public yet.\n\n" +
      "- Every bullet links its source on arc.io, docs.arc.io or community.arc.io.\n" +
      "- Agent-only: take it with a registered ERC-8004 agent identity.\n\n" +
      "**Submit:** the bullets as Markdown on IPFS or in a gist.",
    category: "content",
    tags: ["arc", "summary", "research"],
    rewardUsdc: 2,
    days: 5,
    agentOnly: true,
  },
  {
    title: "Guide: add Arc mainnet to MetaMask and fund it with USDC",
    body:
      "A 250 to 400 word step-by-step guide for a first-time user:\n\n" +
      "1. Add Arc mainnet to MetaMask: chain id 5042, currency USDC with 18 decimals, an RPC listed at " +
      "https://docs.arc.io/arc/references/rpc-endpoints.\n" +
      "2. Get USDC onto Arc from Base or another chain.\n" +
      "3. Point out that USDC is also the gas token, so nothing else is needed.\n\n" +
      "Screenshots or clearly named steps.\n\n" +
      "**Submit:** a link to the guide (Markdown on IPFS, a gist or a published post).",
    category: "content",
    tags: ["guide", "metamask", "onboarding"],
    rewardUsdc: 2,
    days: 7,
  },
  // Added 2026-09-17, after an outside agent took four of the five above within
  // hours: a guide that brings the next agent operators in.
  {
    title: "Guide: an AI agent that earns USDC on ArcBounty through MCP",
    body:
      "A 400 to 700 word guide for a developer who has never used ArcBounty: connect an AI coding agent " +
      "(Claude Code, Codex or Cursor) to Arc mainnet through the `arcbounty-mcp` npm package and let it earn a real bounty.\n\n" +
      "1. Configure `arcbounty-mcp` for Arc mainnet (`ARC_NETWORK=arc-mainnet`) with a fresh wallet. " +
      "The private key goes into the MCP config or an env file, never into the chat.\n" +
      "2. Fund that wallet with a little USDC on Arc mainnet. USDC is also the gas.\n" +
      "3. Register an ERC-8004 identity, find an open bounty, take it, submit the work and see the payout arrive.\n\n" +
      "- Every command and config snippet must work with arcbounty-mcp 0.5.0 and use the tool names it really exposes.\n" +
      "- Use your own take of this bounty as the worked example and include its transaction hash.\n\n" +
      "**Submit:** a link to the guide (Markdown on IPFS, a gist or a published post).",
    category: "content",
    tags: ["guide", "mcp", "agents"],
    rewardUsdc: 3,
    days: 7,
  },
];

const CHECK_ONLY = process.argv.includes("--check");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), ".mainnet-bounties-posted.json");
// Gas stays in the wallet on top of the rewards: approve + 5 createBounty cost
// about 0.05 USDC at 20-30 gwei, so this is a wide margin.
const GAS_MARGIN = parseUnits("0.3", 18);

function readDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[m[1]!] = value;
  }
  return out;
}

const fileEnv = readDotEnv(join(ROOT, ".env"));
const need = (name: string): string => {
  const value = process.env[name]?.trim() || fileEnv[name];
  if (!value) throw new Error(`Missing ${name} in the root .env`);
  return value;
};

const ADAPTER_ABI = [
  { name: "paused", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "usdc", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "maxBountyAmount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    name: "createBounty", type: "function", stateMutability: "nonpayable",
    inputs: [{
      name: "p", type: "tuple", components: [
        { name: "provider", type: "address" },
        { name: "reward", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "ipfsDescHash", type: "string" },
        { name: "category", type: "string" },
        { name: "tags", type: "string[]" },
        { name: "agentOnly", type: "bool" },
        { name: "humanOnly", type: "bool" },
        { name: "requireWorkerBond", type: "bool" },
      ],
    }],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    name: "BountyCreated", type: "event", inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "poster", type: "address", indexed: true },
      { name: "reward", type: "uint256", indexed: false },
      { name: "category", type: "string", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
    ],
  },
] as const;

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

type PostedLog = Record<string, { jobId: string; tx: string; cid: string }>;
const readLog = (): PostedLog => (existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, "utf8")) : {});

/** The contract's createBounty rules, checked before any USDC moves. */
function listingProblems(l: Listing): string[] {
  const problems: string[] = [];
  if (l.rewardUsdc < 1) problems.push("reward below the 1 USDC minimum");
  if (!["dev", "design", "content", "data", "other"].includes(l.category)) problems.push(`invalid category ${l.category}`);
  if (l.tags.length > 10) problems.push("more than 10 tags");
  if (l.tags.some(t => Buffer.byteLength(t) === 0 || Buffer.byteLength(t) > 32)) problems.push("a tag is empty or over 32 bytes");
  if (l.agentOnly && l.humanOnly) problems.push("both agentOnly and humanOnly");
  if (l.days < 1) problems.push("deadline under a day");
  return problems;
}

async function pinMarkdown(jwt: string, l: Listing): Promise<string> {
  const markdown = `# ${l.title}\n\n${l.body}\n\n_Posted by the ArcBounty team._\n`;
  const form = new FormData();
  form.append("file", new Blob([markdown], { type: "text/markdown" }), `${l.title.slice(0, 40).replace(/\W+/g, "-")}.md`);
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Pinata ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return `ipfs://${((await res.json()) as { IpfsHash: string }).IpfsHash}`;
}

async function main() {
  const network = resolveNetwork("arc-mainnet");
  if (network.defaultBountyAdapter?.toLowerCase() !== ADAPTER_ADDRESS.toLowerCase()) {
    throw new Error(`ABORT: the SDK's arc-mainnet adapter is ${network.defaultBountyAdapter}, expected ${ADAPTER_ADDRESS}`);
  }
  const chain = buildChain(network);
  const poster = privateKeyToAccount(need("PRIVATE_KEY") as Hex);
  const jwt = need("PINATA_JWT");
  const pub = createPublicClient({ chain, transport: http(network.rpcUrl) });
  const wallet = createWalletClient({ account: poster, chain, transport: http(network.rpcUrl) });
  const adapter = ADAPTER_ADDRESS as Address;
  const usdc = network.contracts.USDC;

  if ((await pub.getChainId()) !== network.chainId) throw new Error(`ABORT: the RPC is not chain ${network.chainId}`);
  const code = await pub.getCode({ address: adapter });
  if (!code || code === "0x") throw new Error("ABORT: no contract at the adapter address");
  const [paused, adapterUsdc, cap] = await Promise.all([
    pub.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "paused" }),
    pub.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "usdc" }),
    pub.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "maxBountyAmount" }),
  ]);
  if (paused) throw new Error("ABORT: the adapter is paused");
  if (adapterUsdc.toLowerCase() !== usdc.toLowerCase()) throw new Error("ABORT: the adapter settles in a different USDC");

  const problems = LISTINGS.flatMap(l => [
    ...listingProblems(l),
    ...(cap > 0n && parseUnits(String(l.rewardUsdc), 6) > cap ? ["reward above the adapter cap"] : []),
  ].map(p => `"${l.title}": ${p}`));
  if (problems.length > 0) throw new Error(`ABORT:\n  ${problems.join("\n  ")}`);

  const posted = readLog();
  const pending = LISTINGS.filter(l => !posted[l.title]);
  const total = pending.reduce((sum, l) => sum + parseUnits(String(l.rewardUsdc), 6), 0n);
  const [tokenBalance, nativeBalance] = await Promise.all([
    pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [poster.address] }),
    pub.getBalance({ address: poster.address }),
  ]);

  const pinata = await fetch("https://api.pinata.cloud/data/testAuthentication", { headers: { Authorization: `Bearer ${jwt}` } });

  console.log(`poster:  ${poster.address}  ${formatEther(nativeBalance)} USDC on Arc mainnet`);
  console.log(`adapter: ${adapter}  (live, cap ${formatUnits(cap, 6)} USDC)`);
  console.log(`pinata:  ${pinata.ok ? "JWT accepted" : `HTTP ${pinata.status} - pinning will fail`}\n`);
  for (const l of LISTINGS) {
    const who = l.agentOnly ? "agents only" : l.humanOnly ? "humans only" : "agents and humans";
    const status = posted[l.title] ? `already posted as #${posted[l.title]!.jobId}` : "to post";
    console.log(`  ${String(l.rewardUsdc).padStart(2)} USDC  ${l.days}d  ${l.category.padEnd(7)} ${who.padEnd(17)} ${l.title}  [${status}]`);
  }
  console.log(`\ntotal to lock in escrow: ${formatUnits(total, 6)} USDC across ${pending.length} bounties`);

  if (!pinata.ok) throw new Error("ABORT: Pinata rejected PINATA_JWT");
  if (pending.length === 0) {
    console.log("Everything is already posted.");
    return;
  }
  if (nativeBalance < parseUnits(formatUnits(total, 6), 18) + GAS_MARGIN || tokenBalance < total) {
    throw new Error(`ABORT: the wallet needs ${formatUnits(total, 6)} USDC for rewards plus a little for gas`);
  }
  if (CHECK_ONLY) {
    console.log("--check: all checks passed, nothing sent.");
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\nType yes to lock ${formatUnits(total, 6)} USDC and post these bounties: `)).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") {
    console.log("Stopped. Nothing sent.");
    return;
  }

  const allowance = await pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: "allowance", args: [poster.address, adapter] });
  if (allowance < total) {
    const hash = await wallet.writeContract({ address: usdc, abi: ERC20_ABI, functionName: "approve", args: [adapter, total] });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`approved ${formatUnits(total, 6)} USDC: ${hash}`);
  }

  for (const l of pending) {
    const cid = await pinMarkdown(jwt, l);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + l.days * 86_400);
    const hash = await wallet.writeContract({
      address: adapter, abi: ADAPTER_ABI, functionName: "createBounty",
      args: [{
        provider: "0x0000000000000000000000000000000000000000",
        reward: parseUnits(String(l.rewardUsdc), 6),
        deadline,
        ipfsDescHash: cid,
        category: l.category,
        tags: l.tags,
        agentOnly: l.agentOnly ?? false,
        humanOnly: l.humanOnly ?? false,
        requireWorkerBond: false,
      }],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`createBounty reverted for "${l.title}": ${hash}`);
    // Arc's system Transfer log comes first in the receipt, so find the
    // adapter's own event rather than trusting logs[0].
    const [created] = parseEventLogs({ abi: ADAPTER_ABI, eventName: "BountyCreated", logs: receipt.logs })
      .filter(log => log.address.toLowerCase() === adapter.toLowerCase());
    const jobId = created?.args.jobId?.toString() ?? "?";
    posted[l.title] = { jobId, tx: hash, cid };
    writeFileSync(LOG_PATH, JSON.stringify(posted, null, 2));
    console.log(`posted #${jobId}  ${l.title}\n         https://arcbounty.app/bounty/${jobId}  tx ${hash}`);
  }

  console.log(`\ndone. wallet now holds ${formatEther(await pub.getBalance({ address: poster.address }))} USDC.`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
