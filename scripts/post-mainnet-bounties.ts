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
 *   npx tsx post-mainnet-bounties.ts --limit=1 posts at most one, for a bounty a day
 *
 * A listing with `provider` set can only be taken by that address: the board is
 * public, so a task promised to one person is locked to them here. Everything
 * else is first come, first served, and one fast agent can take it all.
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
  createPublicClient, createWalletClient, http, isAddress, parseUnits, formatUnits, formatEther, parseEventLogs,
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
  /** Lock the bounty to one taker; leave unset for anyone. */
  provider?: Address;
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
  // Added 2026-09-17 evening: two 1 USDC checks in the one-flow, repro-steps
  // format the outreach emails offer to other teams. The first needs a phone,
  // so it is humans only; the connect modal had just been fixed (48e3d0e).
  {
    title: "Phone wallet check: connect to arcbounty.app through WalletConnect",
    body:
      "Check whether a phone wallet can connect to https://arcbounty.app through WalletConnect, and report exactly what happens.\n\n" +
      "1. On a computer, open https://arcbounty.app, press Connect Wallet and choose WalletConnect.\n" +
      "2. Scan the QR code with a wallet app on your phone (MetaMask, Rabby, Trust or any other) and approve the connection.\n" +
      "3. Check that your address shows in the top right, open https://arcbounty.app/bounty/7, then disconnect.\n\n" +
      "- Name the phone, the wallet app with its version, and the computer's browser.\n" +
      "- A screenshot for each step, and the exact error text for anything that fails, including a wallet that does not know Arc mainnet (chain id 5042).\n" +
      "- Connecting sends no transaction and costs nothing. If the wallet asks you to send a transaction or pay, stop there and report it.\n" +
      "- A clear report of a failure is paid the same as a clean run.\n\n" +
      "**Submit:** a link to the report with its screenshots (IPFS, a public gist or a published post).",
    category: "other",
    tags: ["qa", "walletconnect", "mobile"],
    rewardUsdc: 1,
    days: 7,
    humanOnly: true,
  },
  {
    title: "Find dead links and outdated facts on the ArcBounty start page, guide and README",
    body:
      "ArcBounty moved to Arc mainnet on 2026-09-16. Read https://arcbounty.app/start, https://arcbounty.app/guide " +
      "and the README at https://github.com/Sofiia7/ARC, and report what is broken or out of date.\n\n" +
      "- Open every link. Report each one that fails, with the page it is on and its link text.\n" +
      "- Report statements that no longer match the live site or Arc mainnet, such as an address, a network name, a fee or a step that does not work. " +
      "Quote the sentence, say what is true now and link the source.\n" +
      "- Wording and style opinions are out of scope.\n" +
      "- If nothing is broken, list every link you checked with its status. A verified clean report is paid too.\n\n" +
      "**Submit:** the findings as Markdown on IPFS or in a gist.",
    category: "content",
    tags: ["docs", "qa", "links"],
    rewardUsdc: 1,
    days: 7,
  },
  // Replaces the phone wallet check (#9, cancelled the same evening): on the
  // board its title read as a dollar for connecting a wallet. This one is real
  // work and feeds the outreach, which needs teams with small backlogs.
  {
    title: "Research: 10 Arc mainnet projects with open issues a newcomer could fix",
    body:
      "Find 10 projects that are live on Arc mainnet (chain id 5042) and have open GitHub issues an outside contributor " +
      "could finish in a day, such as a docs fix, a small bug or a missing example.\n\n" +
      "- For each project: its name, one line on what it does, proof that it runs on Arc mainnet (a contract or explorer link, " +
      "or an official post) and 1 to 3 links to open issues.\n" +
      "- Only issues that are open and were updated in the last 60 days. No ArcBounty repos, forks or duplicates.\n" +
      "- One line per project on why its issue would make a good small paid bounty.\n\n" +
      "**Submit:** a Markdown table on IPFS or in a gist.",
    category: "data",
    tags: ["research", "arc", "github"],
    rewardUsdc: 1,
    days: 7,
  },
  // Added 2026-09-18: one agent took every open listing, so this one asks for
  // what only a newcomer can give, and is humans only.
  {
    title: "First-time user review of arcbounty.app, with screenshots",
    body:
      "Spend 10 minutes on https://arcbounty.app as someone who has never used ArcBounty, and tell us what was unclear.\n\n" +
      "1. Read the home page and https://arcbounty.app/start and work out what ArcBounty is and how you would earn or pay with it.\n" +
      "2. Open two bounties, the leaderboard and the stats page.\n" +
      "3. No wallet connection or payment is needed.\n\n" +
      "- At least five concrete observations, each with what you expected, what you saw and a screenshot.\n" +
      "- Name your device and browser.\n" +
      "- End with your honest first impression in two or three sentences.\n" +
      "- Generic advice such as \"improve the design\" does not count.\n\n" +
      "**Submit:** the review as Markdown on IPFS, in a gist or as a published post.",
    category: "other",
    tags: ["ux", "review", "feedback"],
    rewardUsdc: 1,
    days: 7,
    humanOnly: true,
  },
  // Agreed with the ArcNS maintainer on khenzarr/arcns#51 (2026-09-18/19): we
  // fund, post and pay; ArcNS only agrees the spec and reviews. Their scope and
  // repository rules are copied as given; 10 USDC, 10 days, no bond, humans only.
  {
    title: "TypeScript example: resolve .arc and .circle names with the ArcNS API",
    body:
      "Build a small, standalone TypeScript example for [ArcNS](https://arcname.services) and submit it as a pull request to " +
      "https://github.com/khenzarr/arcns. The scope was agreed with the ArcNS maintainer in https://github.com/khenzarr/arcns/issues/51.\n\n" +
      "**The example must:**\n" +
      "- resolve both `.arc` and `.circle` names to addresses;\n" +
      "- resolve an address to a primary name and display it only when the API returns a verified, forward-confirmed result;\n" +
      "- use the production ArcNS API at https://arcname.services/api/v1;\n" +
      "- handle timeouts, invalid input, not-found names and upstream errors;\n" +
      "- use only synthetic example names and wallet addresses, never real user wallet data;\n" +
      "- need no private key, wallet connection, token approval or onchain transaction;\n" +
      "- include concise run instructions and an automated test or deterministic validation command.\n\n" +
      "**Repository scope:**\n" +
      "- The PR is documentation/example-only, and every change stays under `examples/typescript-resolution/**`.\n" +
      "- It must not modify `frontend/**`, `contracts/**`, API routes, deployment files, environment configuration, " +
      "GitHub Actions, or root package/lock files.\n" +
      "- No `preinstall`, `postinstall` or other lifecycle scripts.\n" +
      "- Prefer zero runtime dependencies. Any development dependency must be minimal, pinned through a lockfile and justified in the PR.\n" +
      "- Default tests use deterministic mocked or local responses and never call the live production API. " +
      "An optional, clearly separated production smoke command is fine.\n" +
      "- No production deployment or API changes.\n\n" +
      "**How it works:**\n" +
      "- Humans only, no worker bond, and nobody is selected in advance. Taking and submitting need a wallet on Arc mainnet " +
      "with a few cents of USDC for gas.\n" +
      "- ArcNS reviews the PR against the lists above, and the payout follows their confirmation that the lists are met. " +
      "A PR that does not meet them is rejected with the reasons.\n" +
      "- Acceptance and payout do not imply a merge: merging stays ArcNS's separate decision after their security review, tests and CI.\n\n" +
      "**Submit:** the pull request link.",
    category: "dev",
    tags: ["typescript", "arcns", "example"],
    rewardUsdc: 10,
    days: 10,
    humanOnly: true,
  },
  // Added 2026-09-23, after #12's first human worker found a real bug in ten
  // minutes: two more humans-only tasks where a newcomer's eyes are the product.
  {
    title: "Onboarding report: take and submit your first ArcBounty job",
    body:
      "This bounty is the test. Take it and submit it as someone new to ArcBounty and Arc mainnet, and write down every step " +
      "and every place where you got stuck.\n\n" +
      "1. Start from https://arcbounty.app/start. Get a wallet onto Arc mainnet (chain id 5042) with a little USDC for gas, " +
      "the way you normally would, and note the route you used (exchange, bridge or anything else) and what it cost.\n" +
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
  {
    title: "Find one reproducible bug on arcbounty.app",
    body:
      "Find one real, reproducible bug on https://arcbounty.app and report it so we can fix it: a page that fails, " +
      "a number that disagrees with another page, a button that does nothing, a layout that breaks on your device.\n\n" +
      "- Steps to reproduce, what you expected, what you saw, a screenshot or a short recording, and your device and browser.\n" +
      "- Not counted: the known issues in the README (https://github.com/Sofiia7/ARC#-known-issues), the mismatch between " +
      "Home, Stats and the Leaderboard already reported in bounty #12, and design or wording opinions.\n" +
      "- No attacks on the contracts or other users, no load testing and no real funds at risk. " +
      "A security issue goes to https://github.com/Sofiia7/ARC/security/advisories/new instead of this bounty.\n\n" +
      "**Submit:** the report as Markdown on IPFS, in a gist or as a published post.",
    category: "other",
    tags: ["qa", "bug", "report"],
    rewardUsdc: 2,
    days: 7,
    humanOnly: true,
  },
];

const CHECK_ONLY = process.argv.includes("--check");
const LIMIT = Number(process.argv.find(a => a.startsWith("--limit="))?.slice(8) ?? "") || LISTINGS.length;
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
  if (l.provider !== undefined && !isAddress(l.provider)) problems.push(`provider ${l.provider} is not an address`);
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
  const pending = LISTINGS.filter(l => !posted[l.title]).slice(0, LIMIT);
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
    const who = l.provider
      ? `only ${l.provider.slice(0, 6)}…${l.provider.slice(-4)}`
      : l.agentOnly ? "agents only" : l.humanOnly ? "humans only" : "agents and humans";
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
        provider: l.provider ?? "0x0000000000000000000000000000000000000000",
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
