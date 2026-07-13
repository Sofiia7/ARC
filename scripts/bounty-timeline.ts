/**
 * viem script: fetch a bounty's on-chain lifecycle timeline.
 *
 * MIT License. Run: npx tsx bounty-timeline.ts
 * Env: ARC_RPC_URL (optional), BOUNTY_ADAPTER_ADDRESS (required), JOB_ID (required)
 */

import { createPublicClient, http, formatUnits, parseAbiItem, type Address, type AbiEvent, type Log } from "viem";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const ADAPTER = process.env.BOUNTY_ADAPTER_ADDRESS as Address;
const JOB_ID = process.env.JOB_ID;

if (!ADAPTER || !JOB_ID) {
  console.error("Missing env: BOUNTY_ADAPTER_ADDRESS / JOB_ID");
  process.exit(1);
}

const jobId = BigInt(JOB_ID);
const client = createPublicClient({ transport: http(RPC) });

// "approved"/"disputed" resolve to whichever of these actually fired:
// BountyCompleted (poster approved) or BountyAutoApproved (14-day timeout) for
// approval, DisputeRaised for a dispute.
const EVENTS = {
  BountyCreated: parseAbiItem("event BountyCreated(uint256 indexed jobId, address indexed poster, uint256 reward, string category, uint256 deadline)"),
  BountyTaken: parseAbiItem("event BountyTaken(uint256 indexed jobId, address indexed provider, uint256 agentId)"),
  WorkSubmitted: parseAbiItem("event WorkSubmitted(uint256 indexed jobId, address indexed provider, string ipfsResultHash)"),
  BountyCompleted: parseAbiItem("event BountyCompleted(uint256 indexed jobId, uint256 agentId, uint256 reputationScore)"),
  BountyAutoApproved: parseAbiItem("event BountyAutoApproved(uint256 indexed jobId, address indexed provider)"),
  DisputeRaised: parseAbiItem("event DisputeRaised(uint256 indexed jobId, address indexed initiator, string reasonHash)"),
} as const;

const CHUNK = 10_000n; // this RPC caps eth_getLogs to a 10,000-block range

// Scans backward in CHUNK-sized windows from `latest` down to `floor`, stopping
// at the first (most recent) match. `floor` bounds the search to the bounty's
// own lifetime (nothing can happen before its BountyCreated block) instead of
// re-scanning the whole chain for events that never occurred.
async function findLogs(event: AbiEvent, floor: bigint, latest: bigint) {
  for (let to = latest; to >= floor; to -= CHUNK) {
    const from = to - CHUNK + 1n > floor ? to - CHUNK + 1n : floor;
    const logs = await client.getLogs({ address: ADAPTER, event, args: { jobId }, fromBlock: from, toBlock: to });
    if (logs.length > 0) return logs;
    if (from === floor) break;
  }
  return [];
}

function describe(name: string, args: any): string {
  switch (name) {
    case "BountyCreated": return `created   reward=${formatUnits(args.reward, 6)} USDC category=${args.category}`;
    case "BountyTaken": return `taken     by=${args.provider}`;
    case "WorkSubmitted": return `submitted result=${args.ipfsResultHash}`;
    case "BountyCompleted": return `approved  reputationScore=${args.reputationScore}`;
    case "BountyAutoApproved": return `approved  (auto, 14d timeout)`;
    case "DisputeRaised": return `disputed  by=${args.initiator}`;
    default: return name;
  }
}

async function main() {
  const latest = await client.getBlockNumber();

  const [created] = await findLogs(EVENTS.BountyCreated, 0n, latest);
  if (!created) {
    console.log(`No BountyCreated found for jobId ${jobId} on ${ADAPTER}`);
    return;
  }

  const timeline: { timestamp: bigint; text: string }[] = [];
  const add = async (name: string, log: Log) => {
    const { timestamp } = await client.getBlock({ blockNumber: log.blockNumber! });
    timeline.push({ timestamp, text: describe(name, (log as any).args) });
  };
  await add("BountyCreated", created);

  for (const [name, event] of Object.entries(EVENTS)) {
    if (name === "BountyCreated") continue;
    for (const log of await findLogs(event, created.blockNumber!, latest)) await add(name, log);
  }

  timeline.sort((a, b) => Number(a.timestamp - b.timestamp));
  for (const e of timeline) {
    const ts = new Date(Number(e.timestamp) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    console.log(`${ts} ${e.text}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
