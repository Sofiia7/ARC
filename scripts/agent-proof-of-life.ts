/**
 * Agent proof-of-life against the current adapter (contracts/DEPLOYMENTS.md).
 *
 * Unlike demo-lifecycle.ts (same wallet on both sides), this runs the real
 * two-party flow the grant application cites as evidence:
 *   worker  = AGENT_PRIVATE_KEY - registers in ERC-8004 (reuses its agentId
 *             if one exists), takes bounties as an agent (agentId > 0),
 *             posts the V4 worker bond where required, submits work
 *   poster  = PRIVATE_KEY       - approves and rates, which also increments
 *             uniquePosterCount(agentId) (V4 anti-Sybil signal)
 *
 * Targets two of the standard seed listings by title so a re-seeded board
 * works without hardcoded jobIds:
 *   1. "TypeScript snippet: pin a Buffer to Pinata v3"  (agentOnly + bond -
 *      exercises the full V4 bond cycle: post → refund at submit)
 *   2. "viem script: watch BountyCreated and print new bounties"
 *
 * Env: same as seed-bounties.ts (PRIVATE_KEY, BOUNTY_ADAPTER_ADDRESS,
 * PINATA_JWT, plus ARC_NETWORK / ALLOW_MAINNET / ARC_TESTNET_RPC_URL - see
 * scripts/lib/network.ts) plus AGENT_PRIVATE_KEY.
 *
 * Usage (from repo root):
 *   cd scripts && npx tsx agent-proof-of-life.ts
 */

import { ArcBountyAgent, type BountyMeta } from "arcbounty-agent-sdk";
import { createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getNetworkName, requireNetworkForMoneyMove, type NetworkName } from "./lib/network.js";

const network   = requireNetworkForMoneyMove();
// Ask for the name the operator actually selected. The old derivation here was
// `network.testnet ? "arc-testnet" : "arc-mainnet"`, which silently collapsed
// all four networks onto the two Arc ones: with ARC_NETWORK=base-mainnet the
// SDK was handed `network: "arc-mainnet"` and resolved Arc's chain id and Arc's
// contract map against a Base RPC. getNetworkName() has already been validated
// by requireNetworkForMoneyMove() above, so this re-read cannot widen anything.
const networkName: NetworkName = getNetworkName();
const RPC       = network.rpcUrl;
// The poster must be the wallet that actually created the listings - only it
// can call approveBounty. That is a different key per network (Base mainnet was
// deployed and seeded from a fresh key that never touched testnet, see
// contracts/DEPLOYMENTS.md), so pick the network's own poster rather than
// assuming PRIVATE_KEY. POSTER_PRIVATE_KEY overrides both when reseeding from
// somewhere else.
const POSTER_PK = (process.env.POSTER_PRIVATE_KEY
  ?? (networkName === "base-mainnet" ? process.env.BASE_MAINNET_DEPLOYER_KEY : undefined)
  ?? process.env.PRIVATE_KEY) as `0x${string}`;
const WORKER_PK = process.env.AGENT_PRIVATE_KEY as `0x${string}`;
// Default to the adapter the SDK already resolves for this network, and treat
// BOUNTY_ADAPTER_ADDRESS as an override. A single `.env` cannot hold the right
// adapter for four chains at once: with Arc's address left in it, a Base run
// would aim every call at an address that holds no code on 8453 and fail with
// an unrelated-looking revert. The code-presence check in main() catches an
// override pointed at the wrong chain.
const ADAPTER_ENV = process.env.BOUNTY_ADAPTER_ADDRESS as Address | undefined;

if (!POSTER_PK || !WORKER_PK) {
  console.error("Missing env: PRIVATE_KEY / AGENT_PRIVATE_KEY");
  process.exit(1);
}
if (!process.env.PINATA_JWT && !(process.env.PINATA_API_KEY && process.env.PINATA_SECRET)) {
  console.error("Set PINATA_JWT (or PINATA_API_KEY + PINATA_SECRET) - results are pinned to IPFS.");
  process.exit(1);
}

// ─── The actual deliverables ─────────────────────────────────────────────────
// Real work, not lorem ipsum: each submission below genuinely satisfies its
// bounty's acceptance criteria, so the poster's approval (and the reputation
// write) is backed by a reviewable artifact - the property the grant
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

/**
 * Which adapter to talk to. One `.env` cannot hold the right adapter for four
 * chains at once, so a stale BOUNTY_ADAPTER_ADDRESS left over from an Arc run
 * is the normal state of things, not operator error - on Base it would aim
 * every call at an address holding no code and fail with an unrelated-looking
 * revert. Zero code is never a legitimate target, so fall back to the
 * network's own adapter and say so loudly rather than stopping.
 */
async function resolveAdapter(rpc: ReturnType<typeof createPublicClient>): Promise<Address> {
  const fallback = network.defaultBountyAdapter as Address;
  if (!ADAPTER_ENV || ADAPTER_ENV.toLowerCase() === fallback.toLowerCase()) return fallback;

  const code = await rpc.getCode({ address: ADAPTER_ENV });
  if (code && code !== "0x") return ADAPTER_ENV;

  console.warn(
    `BOUNTY_ADAPTER_ADDRESS=${ADAPTER_ENV} holds no code on ${network.name} ` +
    `(chain ${network.chainId}) - it belongs to another network. Using this one's adapter ${fallback}.`,
  );
  return fallback;
}

async function main() {
  const rpc = createPublicClient({ transport: http(RPC) });
  const ADAPTER = await resolveAdapter(rpc);

  const worker = new ArcBountyAgent({ privateKey: WORKER_PK, rpcUrl: RPC, bountyAdapterAddress: ADAPTER, network: networkName });
  const poster = new ArcBountyAgent({ privateKey: POSTER_PK, rpcUrl: RPC, bountyAdapterAddress: ADAPTER, network: networkName });

  // The entire point of this script over demo-lifecycle.ts is that the two
  // sides are different wallets. A run where they collapse to one address is
  // a self-payment: it proves the contract moves USDC and nothing else - no
  // counterparty, and uniquePosterCount stays meaningless. Fail loudly here
  // rather than produce a transcript that reads like evidence but is not.
  const workerAddr = privateKeyToAccount(WORKER_PK).address;
  const posterAddr = privateKeyToAccount(POSTER_PK).address;
  console.log(`network: ${networkName} (chain ${network.chainId})  adapter: ${ADAPTER}`);
  console.log(`poster:  ${posterAddr}`);
  console.log(`worker:  ${workerAddr}`);
  if (workerAddr.toLowerCase() === posterAddr.toLowerCase()) {
    console.error(
      `\nRefusing to run: poster and worker are the same wallet (${workerAddr}).\n` +
      `Point AGENT_PRIVATE_KEY at a separate funded wallet - this script exists to ` +
      `produce a two-party payout, not a self-payment.`,
    );
    process.exit(1);
  }

  // Gas is a separate asset on Base (ETH) but is USDC on Arc, so a worker
  // funded only with USDC transacts fine on Arc and dies on the first Base tx.
  // Check before spending anything: an unfunded worker otherwise fails midway,
  // typically after it has already posted its bond.
  const gas: bigint = await rpc.getBalance({ address: workerAddr });
  if (gas === 0n) {
    const { symbol } = network.nativeCurrency;
    console.error(
      `\nRefusing to run: worker ${workerAddr} holds 0 ${symbol} on ${network.name} and ` +
      `cannot pay gas for register/take/submit. Fund it with ${symbol} first.`,
    );
    process.exit(1);
  }

  const agentId = await worker.register(); // reuses an existing agentId if found
  console.log(`worker agentId: ${agentId}  USDC: ${fmt(await worker.usdcBalance())}  gas: ${gas} wei`);

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
      console.warn(`SKIP - no open bounty titled "${target.title}"`);
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
