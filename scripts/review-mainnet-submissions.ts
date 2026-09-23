/**
 * Review and pay the work that came in on ArcBounty's first Arc mainnet bounties.
 *
 * For every bounty in .mainnet-bounties-posted.json it prints who took it, when
 * the work was taken and submitted, a gateway link to the work and the date
 * autoApprove opens, then asks bounty by bounty. Approving releases the escrowed
 * reward to the worker (minus the 1% protocol fee), so this is run by hand. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   npx tsx review-mainnet-submissions.ts           prints the review, asks yes per bounty
 *   npx tsx review-mainnet-submissions.ts --check   prints the review, sends nothing
 *
 * Each approval is saved to scripts/.mainnet-approvals.json right after it lands
 * (take, submit and payout hashes with UTC times and explorer links, the USDC that
 * reached the worker), so the launch thread quotes the chain instead of memory.
 * Reads PRIVATE_KEY (the poster) from the root .env.
 */
// First, before anything touches the network: a dead router DNS must not stop this.
import "./lib/dns-fallback.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createPublicClient, http, formatUnits, formatEther, parseAbi, parseEventLogs, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArcBountyAgent } from "arcbounty-agent-sdk";
import { resolveNetwork } from "../agent-sdk/src/constants.js";
import { buildChain } from "./lib/network.js";

const EXPLORER = "https://arcexplorer.org/tx/";
const GATEWAY = "https://ipfs.io/ipfs/";
const APPROVAL_TIMEOUT = 14n * 86_400n;
const LOG_CHUNK = 90_000n; // Blockdaemon serves eth_getLogs up to 100k blocks
const PRUNED_LOOKBACK = 250_000n; // ~1.5 days of Arc blocks, when older history is pruned away
const CHECK_ONLY = process.argv.includes("--check");

// Suggested reputation score per jobId, from the review of 2026-09-17; a bounty
// without one gets its score typed at the prompt. It is written to
// ERC-8004 only for bounties taken with an agent identity (#1, #4, #5).
const SCORES: Record<string, number> = {
  "1": 90, // full es-419 translation, every code block, address and link kept
  "2": 90, // both PNG sizes, site colours, the required line, SVG sources
  "3": 90, // correct event, reconnect handling, a real output line; 95 lines, not ~60
  "4": 95, // 7 bullets, each sourced on arc.io / docs.arc.io
  "5": 85, // 357 words, the three steps; written in Spanish, bridge step stays generic
};

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const POSTED_LOG = join(HERE, ".mainnet-bounties-posted.json");
const RESULT_PATH = join(HERE, ".mainnet-approvals.json");

const LIFECYCLE_EVENTS = parseAbi([
  "event BountyTaken(uint256 indexed jobId, address indexed provider, uint256 agentId)",
  "event WorkSubmitted(uint256 indexed jobId, address indexed provider, string ipfsResultHash)",
]);
const PAYOUT_EVENTS = parseAbi([
  "event PayoutParked(uint256 indexed jobId, address indexed payee, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

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

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const gateway = (uri: string) => (uri.startsWith("ipfs://") ? GATEWAY + uri.slice("ipfs://".length) : uri);

type Stamp = { hash: Hash; block: string; time: string; link: string };

async function main() {
  if (!existsSync(POSTED_LOG)) throw new Error("No .mainnet-bounties-posted.json - nothing was posted from this machine");
  const posted = JSON.parse(readFileSync(POSTED_LOG, "utf8")) as Record<string, { jobId: string }>;
  const titles = new Map(Object.entries(posted).map(([title, p]) => [p.jobId, title]));

  const network = resolveNetwork("arc-mainnet");
  const pub = createPublicClient({ chain: buildChain(network), transport: http(network.rpcUrl) });
  const posterKey = need("PRIVATE_KEY") as Hex;
  const posterAddress = privateKeyToAccount(posterKey).address;
  const poster = new ArcBountyAgent({ privateKey: posterKey, network: "arc-mainnet" });
  const adapter = network.defaultBountyAdapter;
  const deployBlock = network.adapterDeployBlock;
  if (!adapter || deployBlock === undefined) throw new Error("ABORT: the SDK knows no arc-mainnet adapter or its deploy block");
  const usdc = network.contracts.USDC;

  // Take and submit transactions, found once for every bounty.
  const head = await pub.getBlockNumber();
  const taken = new Map<string, { hash: Hash; block: bigint }>();
  const submitted = new Map<string, { hash: Hash; block: bigint }>();
  const scanFrom = async (start: bigint): Promise<void> => {
    for (let from = start; from <= head; from += LOG_CHUNK) {
      const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
      const logs = await pub.getLogs({ address: adapter, events: LIFECYCLE_EVENTS, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const id = log.args.jobId!.toString();
        // The latest one counts: a bounty can be taken again after a rejection.
        (log.eventName === "BountyTaken" ? taken : submitted).set(id, { hash: log.transactionHash, block: log.blockNumber });
      }
    }
  };
  // These hashes only decorate the saved record; the review itself reads contract
  // storage. Blockdaemon started answering "pruned history unavailable" below
  // block ~22,000,000 on 2026-09-23, which used to abort the whole run, so a
  // pruned window costs the old hashes and nothing else.
  try {
    await scanFrom(BigInt(deployBlock));
  } catch (err) {
    const recent = head > PRUNED_LOOKBACK ? head - PRUNED_LOOKBACK : 0n;
    taken.clear();
    submitted.clear();
    console.warn(`the RPC no longer serves logs from block ${deployBlock} (${err instanceof Error ? err.message.split("\n")[0] : err});`);
    console.warn(`take and submit hashes are recorded only from block ${recent}.`);
    try {
      await scanFrom(recent);
    } catch (err2) {
      console.warn(`even the recent scan failed (${err2 instanceof Error ? err2.message.split("\n")[0] : err2}); they will be saved as null.`);
    }
  }
  const stampOf = async (tx: { hash: Hash; block: bigint }): Promise<Stamp> => {
    const block = await pub.getBlock({ blockNumber: tx.block });
    return { hash: tx.hash, block: tx.block.toString(), time: iso(block.timestamp), link: EXPLORER + tx.hash };
  };

  const now = BigInt(Math.floor(Date.now() / 1000));
  const ready: { jobId: bigint; title: string; worker: string; agentId: bigint; reward: bigint; score: number | undefined }[] = [];
  for (const [id, title] of [...titles].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (id === "?") continue;
    const meta = await poster.getBounty(BigInt(id));
    console.log(`\n#${id}  ${title}  (${formatUnits(meta.reward, 6)} USDC)`);
    const skip =
      meta.poster.toLowerCase() !== posterAddress.toLowerCase() ? "not posted by PRIVATE_KEY"
      : meta.resolved ? "already resolved"
      : meta.inDispute ? "in dispute"
      : meta.rejectedAt > 0n ? "a rejection is pending"
      : !meta.submittedResultHash ? (meta.isTaken ? "taken, no work submitted yet" : "not taken yet")
      : null;
    if (meta.isTaken) {
      console.log(`  worker     ${meta.assignedProvider}${meta.agentId > 0n ? `  ERC-8004 agent #${meta.agentId}` : "  no agent identity"}`);
    }
    if (meta.submittedResultHash) {
      console.log(`  submitted  ${iso(meta.submittedAt)}`);
      console.log(`  work       ${gateway(meta.submittedResultHash)}`);
      const opens = meta.submittedAt + APPROVAL_TIMEOUT;
      console.log(`  autoApprove opens ${iso(opens)}${opens <= now ? " (already open: anyone can pay it out)" : ""}`);
    }
    if (skip) {
      console.log(`  skip: ${skip}`);
      continue;
    }
    console.log(`  score      ${SCORES[id] ?? "not set: you type it when asked"}`);
    ready.push({ jobId: BigInt(id), title, worker: meta.assignedProvider, agentId: meta.agentId, reward: meta.reward, score: SCORES[id] });
  }

  const gas = await pub.getBalance({ address: posterAddress });
  console.log(`\nposter ${posterAddress}  (${formatEther(gas)} USDC for gas)`);
  if (ready.length === 0) {
    console.log("Nothing to approve.");
    return;
  }
  if (gas < 50_000_000_000_000_000n) throw new Error("ABORT: the poster holds under 0.05 USDC for gas. Nothing sent.");
  if (CHECK_ONLY) {
    console.log(`\n--check: ${ready.length} submission(s) ready to approve, nothing sent.`);
    return;
  }

  const results: Record<string, unknown> = existsSync(RESULT_PATH) ? JSON.parse(readFileSync(RESULT_PATH, "utf8")) : {};
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const job of ready) {
      const pay = `release ${formatUnits(job.reward, 6)} USDC to ${job.worker}`;
      const answer = (
        await rl.question(
          job.score === undefined
            ? `\nType a score 0-100 to approve #${job.jobId} and ${pay} (Enter skips): `
            : `\nType yes to approve #${job.jobId} with score ${job.score}, or another score 0-100, and ${pay} (Enter skips): `,
        )
      ).trim().toLowerCase();
      const score = answer === "yes" ? job.score : /^\d{1,3}$/.test(answer) && Number(answer) <= 100 ? Number(answer) : undefined;
      if (score === undefined) {
        console.log(`#${job.jobId} skipped.`);
        continue;
      }
      const { hash } = await poster.approveBounty(job.jobId, score);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`#${job.jobId}: approve ${hash} reverted. Stopped.`);
      const logs = parseEventLogs({ abi: PAYOUT_EVENTS, logs: receipt.logs });
      let paid = 0n;
      for (const l of logs) {
        if (l.eventName !== "Transfer" || l.address.toLowerCase() !== usdc.toLowerCase()) continue;
        if (l.args.to.toLowerCase() === job.worker.toLowerCase()) paid += l.args.value;
      }
      const parked = logs.some(l => l.eventName === "PayoutParked");
      const id = job.jobId.toString();
      results[id] = {
        network: "arc-mainnet",
        jobId: id,
        title: job.title,
        worker: job.worker,
        agentId: job.agentId.toString(),
        score,
        reward: formatUnits(job.reward, 6),
        paidToWorker: formatUnits(paid, 6),
        parked,
        take: taken.has(id) ? await stampOf(taken.get(id)!) : null,
        submit: submitted.has(id) ? await stampOf(submitted.get(id)!) : null,
        approve: await stampOf({ hash, block: receipt.blockNumber }),
        bountyPage: `https://arcbounty.app/bounty/${id}`,
      };
      writeFileSync(RESULT_PATH, JSON.stringify(results, null, 2));
      console.log(
        parked
          ? `#${id} approved, but the payout was parked (the worker can withdraw it): ${EXPLORER}${hash}`
          : `#${id} approved, ${formatUnits(paid, 6)} USDC reached the worker: ${EXPLORER}${hash}`,
      );
    }
  } finally {
    rl.close();
  }
  console.log(`\nsaved to ${RESULT_PATH}`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
