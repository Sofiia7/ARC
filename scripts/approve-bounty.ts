/**
 * Approve a submitted bounty as its poster, and write the reputation score.
 *
 * This is the one step of the lifecycle the MCP server deliberately does not
 * expose: `approveBounty` (with reject/dispute/cancel) is a poster-side
 * judgment call, and mcp-server/src/tools.ts keeps it out of v0 on purpose.
 * The MCP wallet is the worker; approving from it would be self-approval.
 * So the poster half lives here, as its own small script rather than inside
 * agent-proof-of-life.ts, which does the whole take/submit/approve cycle and
 * cannot be pointed at a job an agent already took through some other client.
 *
 * Reads the job first and refuses if anything about it is off: wrong poster,
 * no submission yet, already resolved. Approving is irreversible and pays out,
 * so every check happens before the write.
 *
 * The poster key is resolved exactly as agent-proof-of-life.ts resolves it -
 * POSTER_PRIVATE_KEY, else the network's own (BASE_MAINNET_DEPLOYER_KEY on
 * Base mainnet), else PRIVATE_KEY - so the two scripts cannot disagree about
 * which wallet is the poster.
 *
 * Usage (from scripts/):
 *   ARC_NETWORK=base-mainnet ALLOW_MAINNET=yes \
 *     npx tsx --env-file=../.env approve-bounty.ts <jobId> [score]
 *
 * score is the ERC-8004 reputation score written for the worker, 0-100,
 * default 95.
 */

import { ArcBountyAgent } from "arcbounty-agent-sdk";
import { createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getNetworkName, requireNetworkForMoneyMove } from "./lib/network.js";

const network     = requireNetworkForMoneyMove();
const networkName = getNetworkName();

const POSTER_PK = (process.env.POSTER_PRIVATE_KEY
  ?? (networkName === "base-mainnet" ? process.env.BASE_MAINNET_DEPLOYER_KEY : undefined)
  ?? process.env.PRIVATE_KEY) as `0x${string}` | undefined;

const [jobIdArg, scoreArg] = process.argv.slice(2);

if (!POSTER_PK) {
  console.error("Missing env: POSTER_PRIVATE_KEY / BASE_MAINNET_DEPLOYER_KEY / PRIVATE_KEY");
  process.exit(1);
}
if (!jobIdArg || !/^\d+$/.test(jobIdArg)) {
  console.error("Usage: npx tsx --env-file=../.env approve-bounty.ts <jobId> [score 0-100]");
  process.exit(1);
}

const jobId = BigInt(jobIdArg);
const score = scoreArg === undefined ? 95 : Number(scoreArg);

if (!Number.isInteger(score) || score < 0 || score > 100) {
  console.error(`score must be an integer 0-100, got "${scoreArg}"`);
  process.exit(1);
}

async function main() {
  const rpc = createPublicClient({ transport: http(network.rpcUrl) });
  const posterAddr = privateKeyToAccount(POSTER_PK!).address;

  // Same adapter resolution as agent-proof-of-life.ts: one .env cannot hold the
  // right adapter for four chains, so a stale override that holds no code on
  // this chain falls back to the network's own rather than reverting obscurely.
  const fallback = network.defaultBountyAdapter as Address;
  const override = process.env.BOUNTY_ADAPTER_ADDRESS as Address | undefined;
  let adapter = fallback;
  if (override && override.toLowerCase() !== fallback.toLowerCase()) {
    const code = await rpc.getCode({ address: override });
    if (code && code !== "0x") adapter = override;
    else console.warn(`BOUNTY_ADAPTER_ADDRESS=${override} holds no code on ${network.name} - using ${fallback}.`);
  }

  const poster = new ArcBountyAgent({
    privateKey: POSTER_PK!, rpcUrl: network.rpcUrl, bountyAdapterAddress: adapter, network: networkName,
  });

  const meta = await poster.getBounty(jobId);
  const reward = `${(Number(meta.reward) / 1e6).toFixed(2)} USDC`;

  console.log(`network: ${networkName} (chain ${network.chainId})  adapter: ${adapter}`);
  console.log(`bounty #${jobId}: ${reward}  poster=${meta.poster}  worker=${meta.assignedProvider}`);
  console.log(`approving as: ${posterAddr}  score: ${score}\n`);

  // Only the poster can approve; the contract enforces it, but failing here
  // costs nothing and says which wallet was expected.
  if (meta.poster.toLowerCase() !== posterAddr.toLowerCase()) {
    console.error(`Refusing: #${jobId} was posted by ${meta.poster}, not ${posterAddr}.`);
    process.exit(1);
  }
  if (meta.resolved) {
    console.error(`Refusing: #${jobId} is already resolved - nothing to approve.`);
    process.exit(1);
  }
  if (!meta.submittedResultHash) {
    console.error(`Refusing: #${jobId} has no submission yet. The worker must submit_work first.`);
    process.exit(1);
  }

  console.log(`submission: ${meta.submittedResultHash}`);
  const res = await poster.approveBounty(jobId, score);
  console.log(`approve: ${res.hash}`);
  console.log(`${reward} released to ${meta.assignedProvider}, minus the 1% protocol fee.`);
}

main().catch(err => { console.error(err); process.exit(1); });
