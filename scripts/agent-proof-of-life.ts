/**
 * Agent proof-of-life against the current adapter (contracts/DEPLOYMENTS.md).
 *
 * Unlike demo-lifecycle.ts (same wallet on both sides), this runs the real
 * two-party flow the grant application cites as evidence:
 *   worker  = AGENT_PRIVATE_KEY — registers in ERC-8004 (reuses its agentId
 *             if one exists), takes bounties as an agent (agentId > 0),
 *             posts the V4 worker bond where required, submits work
 *   poster  = PRIVATE_KEY       — approves and rates, which also increments
 *             uniquePosterCount(agentId) (V4 anti-Sybil signal)
 *
 * Targets two of the standard seed listings by title so a re-seeded board
 * works without hardcoded jobIds:
 *   1. "TypeScript snippet: pin a Buffer to Pinata v3"  (agentOnly + bond —
 *      exercises the full V4 bond cycle: post → refund at submit)
 *   2. "viem script: watch BountyCreated and print new bounties"
 *
 * Env: same as seed-bounties.ts (ARC_TESTNET_RPC_URL, PRIVATE_KEY,
 * BOUNTY_ADAPTER_ADDRESS, PINATA_JWT) plus AGENT_PRIVATE_KEY.
 *
 * Usage (from repo root):
 *   cd scripts && npx tsx agent-proof-of-life.ts
 */

import { ArcBountyAgent, type BountyMeta } from "arcbounty-agent-sdk";
import type { Address } from "viem";

const RPC      = process.env.ARC_TESTNET_RPC_URL!;
const POSTER_PK = process.env.PRIVATE_KEY as `0x${string}`;
const WORKER_PK = process.env.AGENT_PRIVATE_KEY as `0x${string}`;
const ADAPTER  = process.env.BOUNTY_ADAPTER_ADDRESS as Address;

if (!RPC || !POSTER_PK || !WORKER_PK || !ADAPTER) {
  console.error("Missing env: ARC_TESTNET_RPC_URL / PRIVATE_KEY / AGENT_PRIVATE_KEY / BOUNTY_ADAPTER_ADDRESS");
  process.exit(1);
}
if (!process.env.PINATA_JWT && !(process.env.PINATA_API_KEY && process.env.PINATA_SECRET)) {
  console.error("Set PINATA_JWT (or PINATA_API_KEY + PINATA_SECRET) — results are pinned to IPFS.");
  process.exit(1);
}

// ─── The actual deliverables ─────────────────────────────────────────────────
// Real work, not lorem ipsum: each submission below genuinely satisfies its
// bounty's acceptance criteria, so the poster's approval (and the reputation
// write) is backed by a reviewable artifact — the property the grant
// application claims for every ArcBounty payout.

const PINATA_V3_SNIPPET = `# Pin a Buffer to Pinata v3 (TypeScript)

\`\`\`typescript
// MIT License. Node 18+ (global fetch/FormData/Blob).
// Pinata v3 upload API: https://docs.pinata.cloud/api-reference/endpoint/upload-a-file

export async function pinBufferToPinata(
  buf: Buffer,
  name: string,
  jwt = process.env.PINATA_JWT!,
): Promise<{ cid: string; size: number }> {
  const form = new FormData();
  form.append("file", new Blob([buf]), name);
  form.append("network", "public"); // v3 requires an explicit network

  const res = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: \`Bearer \${jwt}\` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(\`Pinata v3 upload failed: \${res.status} \${await res.text()}\`);
  }
  const { data } = (await res.json()) as { data: { cid: string; size: number } };
  return { cid: data.cid, size: data.size };
}
\`\`\`

Usage: \`const { cid, size } = await pinBufferToPinata(Buffer.from("hello"), "hello.txt");\`

_Submitted by an autonomous agent via arcbounty-agent-sdk._
`;

const VIEM_WATCHER_SNIPPET = `# Watch BountyCreated with viem

\`\`\`typescript
// MIT License. Run: npx tsx watch-bounties.ts
// Env: ARC_RPC_URL (optional), BOUNTY_ADAPTER_ADDRESS (required)

import { createPublicClient, http, formatUnits, parseAbiItem } from "viem";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const ADAPTER = process.env.BOUNTY_ADAPTER_ADDRESS as \`0x\${string}\`;

const bountyCreated = parseAbiItem(
  "event BountyCreated(uint256 indexed jobId, address indexed poster, uint256 reward, string category, uint256 deadline)",
);

const client = createPublicClient({ transport: http(RPC) });

console.log(\`Watching BountyCreated on \${ADAPTER}…\`);

const unwatch = client.watchEvent({
  address: ADAPTER,
  event: bountyCreated,
  onLogs: logs => {
    for (const log of logs) {
      const { jobId, reward, category } = log.args;
      console.log({
        jobId: jobId?.toString(),
        reward: \`\${formatUnits(reward ?? 0n, 6)} USDC\`,
        category,
      });
    }
  },
  onError: err => console.error("watch error:", err.message),
});

process.on("SIGINT", () => { unwatch(); process.exit(0); });
\`\`\`

_Submitted by an autonomous agent via arcbounty-agent-sdk._
`;

const TARGETS: { title: string; result: string; score: number }[] = [
  { title: "TypeScript snippet: pin a Buffer to Pinata v3", result: PINATA_V3_SNIPPET, score: 97 },
  { title: "viem script: watch BountyCreated and print new bounties", result: VIEM_WATCHER_SNIPPET, score: 95 },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchTitle(meta: BountyMeta): Promise<string> {
  try {
    const cid = meta.ipfsDescHash.replace(/^ipfs:\/\//, "");
    const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
    const text = await res.text();
    return text.split("\n")[0]?.replace(/^#\s*/, "").trim() ?? "";
  } catch {
    return "";
  }
}

const fmt = (n: bigint) => `${(Number(n) / 1e6).toFixed(2)} USDC`;

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const worker = new ArcBountyAgent({ privateKey: WORKER_PK, rpcUrl: RPC, bountyAdapterAddress: ADAPTER });
  const poster = new ArcBountyAgent({ privateKey: POSTER_PK, rpcUrl: RPC, bountyAdapterAddress: ADAPTER });

  const agentId = await worker.register(); // reuses an existing agentId if found
  const info = await worker.getAgentInfo();
  console.log(`worker: ${info.address}  agentId: ${agentId}  balance: ${fmt(await worker.usdcBalance())}`);

  const open = await worker.listOpenBounties({});
  console.log(`open bounties on ${ADAPTER}: ${open.length}`);

  for (const target of TARGETS) {
    const meta = await (async () => {
      for (const m of open) {
        if ((await fetchTitle(m)) === target.title) return m;
      }
      return null;
    })();
    if (!meta) {
      console.warn(`SKIP — no open bounty titled "${target.title}"`);
      continue;
    }

    console.log(`\n[${target.title}] jobId=${meta.jobId} reward=${fmt(meta.reward)} bond=${meta.requireWorkerBond}`);

    const take = await worker.takeBounty(meta.jobId); // SDK handles bond allowance
    console.log(`  take:    ${take.hash}`);

    const submit = await worker.submitWork(meta.jobId, { text: target.result });
    console.log(`  submit:  ${submit.hash}`);

    const approve = await poster.approveBounty(meta.jobId, target.score);
    console.log(`  approve: ${approve.hash} (score ${target.score})`);
  }

  console.log(`\nworker balance after: ${fmt(await worker.usdcBalance())}`);
  console.log(`uniquePosterCount(${agentId}): ${await worker.getUniquePosterCount(agentId)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
