/**
 * Post BaseBounty's own bounties on Base mainnet from the Base deployer, on the
 * V4.7 adapter that went live on 2026-09-28. The Base twin of
 * post-mainnet-bounties.ts: same checks and the same resume log, but gas is ETH
 * here and USDC is only the reward.
 *
 * Real tasks with real USDC in escrow, so this is run by hand and asks before
 * sending. Checked first: the adapter is live and unpaused, every listing
 * passes the contract's createBounty rules, the wallet holds the rewards in
 * USDC plus ETH for gas, and Pinata accepts the JWT. Posted titles go to
 * scripts/.base-bounties-posted.json, so an interrupted run resumes instead of
 * posting duplicates. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   npx tsx post-base-bounties.ts           checks, lists, asks for yes, posts
 *   npx tsx post-base-bounties.ts --check   checks and lists only, sends nothing
 *   npx tsx post-base-bounties.ts --limit=1 posts at most one
 *
 * Reads BASE_MAINNET_DEPLOYER_KEY (the poster) and PINATA_JWT from the root .env.
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

const ADAPTER_ADDRESS = "0x32c215908a46Eb5D34e4E5146c99891eD3014Fee";

// The two tasks that paid off on Arc (#14 and #15, 2026-09-27: a real
// onboarding report and a real layout bug), rewritten for basebounty.app.
const LISTINGS: Listing[] = [
  {
    title: "Find one reproducible bug on basebounty.app",
    body:
      "Find one real, reproducible bug on https://basebounty.app and report it so we can fix it: a page that fails, " +
      "a number that disagrees with another page, a button that does nothing, a layout that breaks on your device.\n\n" +
      "- Steps to reproduce, what you expected, what you saw, a screenshot or a short recording, and your device and browser.\n" +
      "- Not counted: the known issues in the README (https://github.com/Sofiia7/ARC#-known-issues) and design or wording opinions.\n" +
      "- No attacks on the contracts or other users, no load testing and no real funds at risk. " +
      "A security issue goes to https://github.com/Sofiia7/ARC/security/advisories/new instead of this bounty.\n\n" +
      "AI agents and humans can both take this one.\n\n" +
      "**Submit:** the report as Markdown on IPFS, in a gist or as a published post.",
    category: "other",
    tags: ["qa", "bug", "report"],
    rewardUsdc: 2,
    days: 7,
  },
  {
    title: "Onboarding report: take and submit your first BaseBounty job",
    body:
      "This bounty is the test. Take it and submit it as someone new to BaseBounty, and write down every step " +
      "and every place where you got stuck.\n\n" +
      "1. Start from https://basebounty.app/start. Get a wallet onto Base (chain id 8453) with a little ETH for gas, " +
      "the way you normally would, and note the route you used (exchange, bridge or anything else) and what it cost. " +
      "The reward is paid in USDC; gas on Base is paid in ETH.\n" +
      "2. Connect your wallet, take this bounty and submit your report as the work.\n\n" +
      "- A numbered list of every step you took, with a screenshot for each wallet or network step.\n" +
      "- For each problem: what you expected, what happened, the exact error text and how you got past it, or that you did not.\n" +
      "- Name your wallet app, device and browser.\n" +
      "- Never share a seed phrase or private key, and make sure none is visible in a screenshot.\n\n" +
      "**Submit:** the report as Markdown on IPFS, in a gist or as a published post.",
    category: "other",
    tags: ["onboarding", "ux", "report"],
    rewardUsdc: 2,
    days: 7,
    humanOnly: true,
  },
];

const CHECK_ONLY = process.argv.includes("--check");
const LIMIT = Number(process.argv.find(a => a.startsWith("--limit="))?.slice(8) ?? "") || LISTINGS.length;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const LOG_PATH = join(HERE, ".base-bounties-posted.json");
// approve + two createBounty cost well under 0.00005 ETH at Base's usual 0.005-0.01 gwei.
const GAS_MARGIN_ETH = parseUnits("0.0001", 18);

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
  const markdown = `# ${l.title}\n\n${l.body}\n\n_Posted by the BaseBounty team._\n`;
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
  const network = resolveNetwork("base-mainnet");
  if (network.defaultBountyAdapter?.toLowerCase() !== ADAPTER_ADDRESS.toLowerCase()) {
    throw new Error(`ABORT: the SDK's base-mainnet adapter is ${network.defaultBountyAdapter}, expected ${ADAPTER_ADDRESS}`);
  }
  const chain = buildChain(network);
  const poster = privateKeyToAccount(need("BASE_MAINNET_DEPLOYER_KEY") as Hex);
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
  const pending = LISTINGS.filter(l => !posted[l.title]).slice(0, LIMIT);
  const total = pending.reduce((sum, l) => sum + parseUnits(String(l.rewardUsdc), 6), 0n);
  const [tokenBalance, ethBalance] = await Promise.all([
    pub.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [poster.address] }),
    pub.getBalance({ address: poster.address }),
  ]);

  const pinata = await fetch("https://api.pinata.cloud/data/testAuthentication", { headers: { Authorization: `Bearer ${jwt}` } });

  console.log(`poster:  ${poster.address}  ${formatUnits(tokenBalance, 6)} USDC, ${formatEther(ethBalance)} ETH on Base`);
  console.log(`adapter: ${adapter}  (live, cap ${formatUnits(cap, 6)} USDC)`);
  console.log(`pinata:  ${pinata.ok ? "JWT accepted" : `HTTP ${pinata.status} - pinning will fail`}\n`);
  for (const l of LISTINGS) {
    const who = l.agentOnly ? "agents only" : l.humanOnly ? "humans only" : "agents and humans";
    const status = posted[l.title] ? `already posted as #${posted[l.title]!.jobId}`
      : pending.includes(l) ? "to post" : "waiting (over --limit)";
    console.log(`  ${String(l.rewardUsdc).padStart(2)} USDC  ${l.days}d  ${l.category.padEnd(7)} ${who.padEnd(17)} ${l.title}  [${status}]`);
  }
  console.log(`\ntotal to lock in escrow: ${formatUnits(total, 6)} USDC across ${pending.length} bounties`);

  if (!pinata.ok) throw new Error("ABORT: Pinata rejected PINATA_JWT");
  if (pending.length === 0) {
    console.log("Everything is already posted.");
    return;
  }
  if (tokenBalance < total) {
    throw new Error(`ABORT: the wallet holds ${formatUnits(tokenBalance, 6)} USDC on Base and needs ${formatUnits(total, 6)}. Send the difference to ${poster.address} on Base.`);
  }
  if (ethBalance < GAS_MARGIN_ETH) throw new Error(`ABORT: the wallet needs at least ${formatEther(GAS_MARGIN_ETH)} ETH on Base for gas`);
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
    // The adapter's own event, not the first log in the receipt (USDC's Transfer comes first).
    const [created] = parseEventLogs({ abi: ADAPTER_ABI, logs: receipt.logs, eventName: "BountyCreated" })
      .filter(log => log.address.toLowerCase() === adapter.toLowerCase());
    const jobId = created?.args.jobId?.toString() ?? "?";
    posted[l.title] = { jobId, tx: hash, cid };
    writeFileSync(LOG_PATH, JSON.stringify(posted, null, 2));
    console.log(`posted #${jobId}: ${l.title}\n  https://basebounty.app/bounty/${jobId}\n  https://basescan.org/tx/${hash}`);
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
