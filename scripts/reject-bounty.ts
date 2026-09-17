/**
 * Reject a submitted bounty as its poster, with a reason pinned to IPFS.
 *
 * The counterpart of approve-bounty.ts, for work that should not be paid: the
 * first case was BaseBounty #3 on 2026-09-17, whose submission CID had no
 * provider anywhere on IPFS, so there was nothing to review.
 *
 * What a rejection starts: the worker gets REJECTION_CHALLENGE_WINDOW (48h) to
 * challenge it, which turns it into a dispute for the arbitrator. Unchallenged,
 * anyone may then call finalizeRejection and the reward returns to the poster.
 * A rejection is only accepted inside the approval window (14 days from the
 * submission); after that autoApprove is the only way forward, so this script
 * refuses once the window has closed.
 *
 * Poster key and adapter resolve exactly as in approve-bounty.ts. Asks for yes
 * before sending. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   set "ARC_NETWORK=base-mainnet" && set "ALLOW_MAINNET=yes" && npx tsx --env-file=..\.env reject-bounty.ts <jobId> "<reason>"
 */

import { ArcBountyAgent } from "arcbounty-agent-sdk";
import { createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createInterface } from "node:readline/promises";
import { getNetworkName, requireNetworkForMoneyMove } from "./lib/network.js";

const APPROVAL_TIMEOUT_S = 14n * 86_400n;

const network     = requireNetworkForMoneyMove();
const networkName = getNetworkName();

const POSTER_PK = (process.env.POSTER_PRIVATE_KEY
  ?? (networkName === "base-mainnet" ? process.env.BASE_MAINNET_DEPLOYER_KEY : undefined)
  ?? process.env.PRIVATE_KEY) as `0x${string}` | undefined;

const [jobIdArg, ...reasonParts] = process.argv.slice(2);
const reason = reasonParts.join(" ").trim();

if (!POSTER_PK) {
  console.error("Missing env: POSTER_PRIVATE_KEY / BASE_MAINNET_DEPLOYER_KEY / PRIVATE_KEY");
  process.exit(1);
}
if (!jobIdArg || !/^\d+$/.test(jobIdArg) || !reason) {
  console.error('Usage: npx tsx --env-file=..\\.env reject-bounty.ts <jobId> "<reason>"');
  process.exit(1);
}
if (!process.env.PINATA_JWT) {
  console.error("Missing env: PINATA_JWT - the reason is pinned to IPFS before the rejection is sent");
  process.exit(1);
}

const jobId = BigInt(jobIdArg);
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

async function main() {
  const rpc = createPublicClient({ transport: http(network.rpcUrl) });
  const posterAddr = privateKeyToAccount(POSTER_PK!).address;

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
  const now = BigInt(Math.floor(Date.now() / 1000));
  const windowCloses = meta.submittedAt + APPROVAL_TIMEOUT_S;

  console.log(`network: ${networkName} (chain ${network.chainId})  adapter: ${adapter}`);
  console.log(`bounty #${jobId}: ${reward}  poster=${meta.poster}  worker=${meta.assignedProvider}`);
  console.log(`rejecting as: ${posterAddr}`);
  console.log(`submission: ${meta.submittedResultHash || "-"}  submitted ${meta.submittedAt > 0n ? iso(meta.submittedAt) : "-"}`);
  console.log(`reason: ${reason}\n`);

  const refuse = (why: string) => { console.error(`Refusing: ${why}`); process.exit(1); };
  if (meta.poster.toLowerCase() !== posterAddr.toLowerCase()) refuse(`#${jobId} was posted by ${meta.poster}, not ${posterAddr}.`);
  if (meta.resolved) refuse(`#${jobId} is already resolved.`);
  if (!meta.submittedResultHash) refuse(`#${jobId} has no submission - nothing to reject.`);
  if (meta.inDispute) refuse(`#${jobId} is already in dispute.`);
  if (meta.rejectedAt > 0n) refuse(`#${jobId} already has a pending rejection (since ${iso(meta.rejectedAt)}).`);
  if (now >= windowCloses) refuse(`the approval window closed at ${iso(windowCloses)}; only autoApprove is possible now.`);

  console.log(`The approval window closes ${iso(windowCloses)}. After a rejection the worker has 48h to challenge it;`);
  console.log(`unchallenged, anyone can finalize it and ${reward} returns to the poster.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\nType yes to reject #${jobId}: `)).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") {
    console.log("Stopped. Nothing sent.");
    return;
  }

  const res = await poster.rejectBounty(jobId, { text: reason });
  console.log(`reject: ${res.hash}`);
  console.log(`Challenge window open until about ${iso(now + 48n * 3_600n)}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
