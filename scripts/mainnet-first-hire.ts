/**
 * The first hire on Arc mainnet: the agent wallet takes the agent-only bounty
 * "Summarize the Arc mainnet launch for builders", delivers a real summary and
 * the poster approves it, which pays the agent from escrow.
 *
 * The three transaction hashes, their UTC times and the minutes from take to
 * payout are what the launch thread and its video quote, so they are written to
 * scripts/.mainnet-first-hire.json rather than retyped by hand.
 *
 * The approval releases real USDC, so this is run by hand and asks before
 * sending. Run post-mainnet-bounties.ts first. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   npx tsx mainnet-first-hire.ts           checks, asks for yes, runs the hire
 *   npx tsx mainnet-first-hire.ts --check   checks only, sends nothing
 *
 * Reads PRIVATE_KEY (poster), AGENT_PRIVATE_KEY (worker) and PINATA_JWT from the
 * root .env.
 */
// First, before anything touches the network: a dead router DNS must not stop this.
import "./lib/dns-fallback.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createPublicClient, http, formatUnits, formatEther, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArcBountyAgent, pinAgentMetadata } from "arcbounty-agent-sdk";
import { resolveNetwork } from "../agent-sdk/src/constants.js";
import { buildChain } from "./lib/network.js";

const TARGET_TITLE = "Summarize the Arc mainnet launch for builders";
const EXPLORER = "https://arcexplorer.org/tx/";
const CHECK_ONLY = process.argv.includes("--check");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const POSTED_LOG = join(HERE, ".mainnet-bounties-posted.json");
const RESULT_PATH = join(HERE, ".mainnet-first-hire.json");

// The deliverable. Every bullet carries its source, as the bounty requires.
const SUMMARY = `# Arc mainnet launch: what matters to builders (2026-09-16)

- Public mainnet opened on 2026-09-16 on chain ID 5042. Circle runs https://rpc.mainnet.arc.io, and Alchemy, Blockdaemon, dRPC and QuickNode serve it too. Source: https://docs.arc.io/arc/references/rpc-endpoints
- USDC is the gas token. Natively it has 18 decimals, while the ERC-20 interface at 0x3600000000000000000000000000000000000000 has 6, so keep the two apart in balance math. Source: https://docs.arc.io/arc/references/evm-differences
- The mempool silently drops transactions with maxFeePerGas under 20 gwei, and finality is deterministic on inclusion, so one confirmation is final. Source: https://docs.arc.io/arc/references/evm-differences
- Value transfers revert in places Ethereum lets them through: sends to the zero address, burns, and blocklisted addresses. Source: https://docs.arc.io/arc/references/evm-differences
- CCTP V2 (domain 26) and Gateway are deployed on mainnet, which is how USDC arrives from other chains. Source: https://docs.arc.io/arc/references/contract-addresses
- DeFi markets from Aave, Morpho and Uniswap are live, alongside tokenized funds from BlackRock and Janus Henderson. Source: https://www.arc.io/blog/arc-economic-os-internet
- Builder tooling at launch: Arc Studio, Arc App Kits, and Circle Agent Stack for policy-controlled agent wallets and USDC nanopayments. Source: https://www.arc.io/blog/arc-economic-os-internet
- Not public yet: Circle's own explorer, explorer.arc.io, is still marked permissioned. Source: https://docs.arc.io/arc/references/rpc-endpoints
`;

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

async function main() {
  // The SDK pins through process.env; the generic testnet adapter/RPC
  // variables are ignored on mainnet by the SDK itself.
  process.env["PINATA_JWT"] = need("PINATA_JWT");

  if (!existsSync(POSTED_LOG)) throw new Error("Run post-mainnet-bounties.ts first - no posted bounties recorded yet");
  const posted = JSON.parse(readFileSync(POSTED_LOG, "utf8")) as Record<string, { jobId: string }>;
  const entry = posted[TARGET_TITLE];
  if (!entry || entry.jobId === "?") throw new Error(`"${TARGET_TITLE}" is not recorded as posted`);
  const jobId = BigInt(entry.jobId);

  const network = resolveNetwork("arc-mainnet");
  const pub = createPublicClient({ chain: buildChain(network), transport: http(network.rpcUrl) });
  const posterKey = need("PRIVATE_KEY") as Hex;
  const workerKey = need("AGENT_PRIVATE_KEY") as Hex;
  const posterAddress = privateKeyToAccount(posterKey).address;
  const workerAddress = privateKeyToAccount(workerKey).address;
  if (posterAddress.toLowerCase() === workerAddress.toLowerCase()) throw new Error("ABORT: poster and worker are the same wallet");

  const poster = new ArcBountyAgent({ privateKey: posterKey, network: "arc-mainnet" });
  const worker = new ArcBountyAgent({ privateKey: workerKey, network: "arc-mainnet" });

  const meta = await poster.getBounty(jobId);
  const problems = [
    meta.poster.toLowerCase() !== posterAddress.toLowerCase() && "the bounty was not posted by PRIVATE_KEY",
    !meta.agentOnly && "the bounty is not agent-only",
    meta.isTaken && "the bounty is already taken",
    meta.resolved && "the bounty is already resolved",
    meta.deadline * 1000n <= BigInt(Date.now()) && "the bounty has expired",
  ].filter(Boolean);
  const workerGas = await pub.getBalance({ address: workerAddress });
  if (workerGas < 50_000_000_000_000_000n) problems.push("the worker holds under 0.05 USDC for gas");
  if (problems.length > 0) throw new Error(`ABORT: ${problems.join("; ")}. Nothing sent.`);

  console.log(`bounty #${jobId}  "${TARGET_TITLE}"  reward ${formatUnits(meta.reward, 6)} USDC, agent-only`);
  console.log(`poster ${posterAddress}`);
  console.log(`worker ${workerAddress}  (${formatEther(workerGas)} USDC for gas)`);
  console.log("plan: register the worker's ERC-8004 identity if it has none, take, submit the summary, approve (pays the agent)");

  if (CHECK_ONLY) {
    console.log("\n--check: all checks passed, nothing sent.");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("\nType yes to run the hire and pay the agent from escrow: ")).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") {
    console.log("Stopped. Nothing sent.");
    return;
  }

  const metadataURI = await pinAgentMetadata({
    name: "ArcBounty launch agent",
    description: "Autonomous worker that takes ArcBounty jobs through arcbounty-agent-sdk.",
    agent_type: "autonomous",
    capabilities: ["research", "writing"],
    arcbounty: { preferred_categories: ["content", "dev"] },
  });
  const agentId = await worker.register(metadataURI);
  console.log(`agent identity: #${agentId}`);

  const stamp = async (label: string, hash: Hash) => {
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    const iso = new Date(Number(block.timestamp) * 1000).toISOString();
    console.log(`${label.padEnd(7)} ${hash}  block ${receipt.blockNumber}  ${iso}`);
    return { hash, block: receipt.blockNumber.toString(), time: iso, link: `${EXPLORER}${hash}` };
  };

  const take = await stamp("take", (await worker.takeBounty(jobId)).hash);
  const submit = await stamp("submit", (await worker.submitWork(jobId, { text: SUMMARY })).hash);
  // Measured across the approval only: gas on Arc comes out of the same USDC
  // balance, and the worker spends none while the poster approves.
  const paidBefore = await worker.usdcBalance();
  const approve = await stamp("paid", (await poster.approveBounty(jobId, 95)).hash);
  const paid = (await worker.usdcBalance()) - paidBefore;
  const minutes = Math.round((Date.parse(approve.time) - Date.parse(take.time)) / 60_000);

  const result = {
    network: "arc-mainnet",
    jobId: jobId.toString(),
    title: TARGET_TITLE,
    agentId: agentId.toString(),
    worker: workerAddress,
    poster: posterAddress,
    reward: formatUnits(meta.reward, 6),
    paidToAgent: formatUnits(paid, 6),
    minutesTakeToPaid: minutes,
    take,
    submit,
    approve,
    bountyPage: `https://arcbounty.app/bounty/${jobId}`,
  };
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
  console.log(`\nagent paid ${result.paidToAgent} USDC, ${minutes} min from take to payout`);
  console.log(`saved to ${RESULT_PATH}`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
