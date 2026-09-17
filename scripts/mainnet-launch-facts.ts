/**
 * The launch thread's numbers, read back from the chain after the first Arc
 * mainnet bounties were paid: which worker took most of them and how fast, the
 * bounty it posted itself, what it was paid and the reputation the escrow wrote.
 * Only reads. Run after review-mainnet-submissions.ts. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   npx tsx mainnet-launch-facts.ts
 *
 * Writes scripts/.mainnet-launch-facts.json. marketing_new/arc-mainnet-launch
 * (thread.md and record.py) quotes that file, never numbers typed by hand.
 */
// First, before anything touches the network: a dead router DNS must not stop this.
import "./lib/dns-fallback.js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, formatUnits, parseUnits, parseAbi, type Address, type Hash } from "viem";
import { ArcBountyAgent } from "arcbounty-agent-sdk";
import { resolveNetwork } from "../agent-sdk/src/constants.js";
import { buildChain } from "./lib/network.js";

const EXPLORER = "https://arcexplorer.org/tx/";
const LOG_CHUNK = 90_000n; // Blockdaemon serves eth_getLogs up to 100k blocks
const HERE = dirname(fileURLToPath(import.meta.url));
const APPROVALS_PATH = join(HERE, ".mainnet-approvals.json");
const OUT_PATH = join(HERE, ".mainnet-launch-facts.json");
// A throwaway key: every call below is a read, and the SDK wants a signer.
const READ_ONLY_KEY = `0x${"11".repeat(32)}` as const;

type Stamp = { hash: Hash; block: string; time: string; link: string };
type Approval = {
  jobId: string; title: string; worker: Address; agentId: string;
  reward: string; paidToWorker: string; take: Stamp; submit: Stamp; approve: Stamp;
};

const ADAPTER_EVENTS = parseAbi([
  "event BountyCreated(uint256 indexed jobId, address indexed poster, uint256 reward, string category, uint256 deadline)",
]);
const IDENTITY_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);
const REPUTATION_ABI = parseAbi([
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

const ms = (iso: string) => Date.parse(iso);
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const usdc = (values: string[]) => formatUnits(values.reduce((sum, v) => sum + parseUnits(v, 6), 0n), 6);
const heading = (markdown: string) => markdown.split(/\r?\n/).find(l => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";

// ipfs.io answers scripts with 429 ("service worker gateway only"), so try several.
const GATEWAYS = ["https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://w3s.link/ipfs/", "https://ipfs.io/ipfs/"];

async function ipfsJson(uri: string): Promise<Record<string, unknown> | null> {
  if (!uri.startsWith("ipfs://")) return null;
  for (const gateway of GATEWAYS) {
    try {
      const res = await fetch(gateway + uri.slice("ipfs://".length), { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {
      // next gateway
    }
  }
  return null;
}

async function main() {
  const approvals = Object.values(JSON.parse(readFileSync(APPROVALS_PATH, "utf8")) as Record<string, Approval>);
  if (approvals.length === 0) throw new Error("No approvals recorded - run review-mainnet-submissions.ts first");

  const network = resolveNetwork("arc-mainnet");
  const adapter = network.defaultBountyAdapter;
  const deployBlock = network.adapterDeployBlock;
  if (!adapter || deployBlock === undefined) throw new Error("ABORT: the SDK knows no arc-mainnet adapter or its deploy block");
  const pub = createPublicClient({ chain: buildChain(network), transport: http(network.rpcUrl) });
  const reader = new ArcBountyAgent({ privateKey: READ_ONLY_KEY, network: "arc-mainnet" });

  // The story is about the worker that took the most jobs.
  const byWorker = new Map<string, Approval[]>();
  for (const a of approvals) byWorker.set(a.worker.toLowerCase(), [...(byWorker.get(a.worker.toLowerCase()) ?? []), a]);
  const jobs = [...byWorker.values()].sort((a, b) => b.length - a.length)[0]!;
  const agent = jobs[0]!.worker;
  const agentId = BigInt(jobs.map(j => j.agentId).find(id => id !== "0") ?? "0");

  const head = await pub.getBlockNumber();
  const created = new Map<string, { poster: Address; time: string; hash: Hash }>();
  let identityMint: { time: string; hash: Hash } | null = null;
  for (let from = BigInt(deployBlock); from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    for (const log of await pub.getLogs({ address: adapter, events: ADAPTER_EVENTS, fromBlock: from, toBlock: to })) {
      const block = await pub.getBlock({ blockNumber: log.blockNumber });
      created.set(log.args.jobId!.toString(), { poster: log.args.poster!, time: iso(block.timestamp), hash: log.transactionHash });
    }
    if (agentId > 0n && !identityMint) {
      const mints = await pub.getLogs({
        address: network.contracts.IDENTITY_REGISTRY,
        event: IDENTITY_ABI[0],
        args: { from: "0x0000000000000000000000000000000000000000", tokenId: agentId },
        fromBlock: from,
        toBlock: to,
      });
      if (mints[0]) {
        const block = await pub.getBlock({ blockNumber: mints[0].blockNumber });
        identityMint = { time: iso(block.timestamp), hash: mints[0].transactionHash };
      }
    }
  }

  const postedTimes = approvals.map(a => created.get(a.jobId)?.time).filter((t): t is string => !!t).sort();
  const takes = jobs.map(j => j.take.time).sort();
  const submits = jobs.map(j => j.submit.time).sort();
  const paids = jobs.map(j => j.approve.time).sort();

  let agentOnly: Approval | undefined;
  for (const j of jobs) if ((await reader.getBounty(BigInt(j.jobId))).agentOnly) agentOnly = j;

  const ownBounties = [];
  for (const [jobId, c] of [...created].filter(([, c]) => c.poster.toLowerCase() === agent.toLowerCase())) {
    const meta = await reader.getBounty(BigInt(jobId));
    const description = await reader.getBountyDescription(BigInt(jobId)).catch(() => "");
    ownBounties.push({
      jobId,
      title: heading(description),
      rewardUsdc: formatUnits(meta.reward, 6),
      humanOnly: meta.humanOnly,
      agentOnly: meta.agentOnly,
      createdAt: c.time,
      minutesAfterFirstSubmit: Math.round((ms(c.time) - ms(submits[0]!)) / 60_000),
      open: !meta.isTaken && !meta.resolved,
      link: `https://arcbounty.app/bounty/${jobId}`,
      tx: EXPLORER + c.hash,
    });
  }

  let reputation = null;
  if (agentId > 0n) {
    const [count, value, decimals] = await pub.readContract({
      address: network.contracts.REPUTATION_REGISTRY,
      abi: REPUTATION_ABI,
      functionName: "getSummary",
      args: [agentId, [adapter], "", ""],
    });
    reputation = { count: Number(count), average: Number(value) / 10 ** decimals, writtenBy: adapter };
  }
  const registration = agentId > 0n
    ? await ipfsJson(await pub.readContract({ address: network.contracts.IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "tokenURI", args: [agentId] }))
    : null;

  const facts = {
    network: "arc-mainnet",
    readAt: new Date().toISOString(),
    posted: { bounties: approvals.length, rewardUsdc: usdc(approvals.map(a => a.reward)), firstAt: postedTimes[0], lastAt: postedTimes.at(-1) },
    agent: {
      address: agent,
      agentId: agentId.toString(),
      name: typeof registration?.["name"] === "string" ? registration["name"] : null,
      profile: agentId > 0n ? `https://arcbounty.app/agent/${agentId}` : null,
      identityMintedAt: identityMint?.time ?? null,
      identityTx: identityMint ? EXPLORER + identityMint.hash : null,
    },
    agentJobs: {
      count: jobs.length,
      jobIds: jobs.map(j => j.jobId).sort((a, b) => Number(a) - Number(b)),
      firstTakeAt: takes[0],
      lastSubmitAt: submits.at(-1),
      minutesFirstTakeToLastSubmit: Math.round((ms(submits.at(-1)!) - ms(takes[0]!)) / 60_000),
      firstSubmitAt: submits[0],
      firstPaidAt: paids[0],
      lastPaidAt: paids.at(-1),
      hoursFirstSubmitToFirstPaid: Math.round((ms(paids[0]!) - ms(submits[0]!)) / 3_600_000),
      paidUsdc: usdc(jobs.map(j => j.paidToWorker)),
    },
    agentOnlyJob: agentOnly
      ? {
          jobId: agentOnly.jobId,
          title: agentOnly.title,
          secondsIdentityToTake: identityMint ? Math.round((ms(agentOnly.take.time) - ms(identityMint.time)) / 1000) : null,
          take: agentOnly.take,
          submit: agentOnly.submit,
          approve: agentOnly.approve,
          paidUsdc: agentOnly.paidToWorker,
        }
      : null,
    ownBounties,
    reputation,
    otherWorkers: [...byWorker.values()]
      .filter(list => list[0]!.worker.toLowerCase() !== agent.toLowerCase())
      .map(list => ({ address: list[0]!.worker, jobIds: list.map(j => j.jobId), paidUsdc: usdc(list.map(j => j.paidToWorker)) })),
  };
  writeFileSync(OUT_PATH, JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts, null, 2));
  console.log(`\nsaved to ${OUT_PATH}`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
