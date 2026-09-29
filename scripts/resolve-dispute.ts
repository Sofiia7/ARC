/**
 * Rule on a dispute as the adapter's arbitrator: pay the worker or refund the
 * poster, with the ruling pinned to IPFS. First used for BaseBounty #8 on
 * 2026-09-29: we rejected a bug report whose file no IPFS node served, the
 * worker pinned it and challenged, and the report was a real bug.
 *
 * Only the arbitrator can rule, and the script checks the key is it. On Base
 * that is the deployer key until the Safe accepts the role; after that the
 * Safe rules in app.safe.global, not here. Asks for yes before sending. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   set "ARC_NETWORK=base-mainnet" && set "ALLOW_MAINNET=yes" && npx tsx --env-file=..\.env resolve-dispute.ts <jobId> pay|refund "<ruling>"
 */

// First, before anything touches the network: a dead router DNS must not stop this.
import "./lib/dns-fallback.js";
import { ArcBountyAgent } from "arcbounty-agent-sdk";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createInterface } from "node:readline/promises";
import { getNetworkName, requireNetworkForMoneyMove } from "./lib/network.js";

const network     = requireNetworkForMoneyMove();
const networkName = getNetworkName();

const ARBITRATOR_PK = (process.env.ARBITRATOR_PRIVATE_KEY
  ?? (networkName === "base-mainnet" ? process.env.BASE_MAINNET_DEPLOYER_KEY : undefined)
  ?? process.env.PRIVATE_KEY) as `0x${string}` | undefined;

const [jobIdArg, outcomeArg, ...rulingParts] = process.argv.slice(2);
const ruling = rulingParts.join(" ").trim();

if (!ARBITRATOR_PK) {
  console.error("Missing env: ARBITRATOR_PRIVATE_KEY / BASE_MAINNET_DEPLOYER_KEY / PRIVATE_KEY");
  process.exit(1);
}
if (!jobIdArg || !/^\d+$/.test(jobIdArg) || (outcomeArg !== "pay" && outcomeArg !== "refund") || !ruling) {
  console.error('Usage: npx tsx --env-file=..\\.env resolve-dispute.ts <jobId> pay|refund "<ruling>"');
  process.exit(1);
}
if (!process.env.PINATA_JWT) {
  console.error("Missing env: PINATA_JWT - the ruling is pinned to IPFS before it is sent");
  process.exit(1);
}

const jobId = BigInt(jobIdArg);
const payProvider = outcomeArg === "pay";
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

async function main() {
  const rpc = createPublicClient({ transport: http(network.rpcUrl) });
  const arbitratorAddr = privateKeyToAccount(ARBITRATOR_PK!).address;

  const fallback = network.defaultBountyAdapter as Address;
  const override = process.env.BOUNTY_ADAPTER_ADDRESS as Address | undefined;
  let adapter = fallback;
  if (override && override.toLowerCase() !== fallback.toLowerCase()) {
    const code = await rpc.getCode({ address: override });
    if (code && code !== "0x") adapter = override;
    else console.warn(`BOUNTY_ADAPTER_ADDRESS=${override} holds no code on ${network.name} - using ${fallback}.`);
  }

  const onChainArbitrator = await rpc.readContract({
    address: adapter, abi: parseAbi(["function arbitrator() view returns (address)"]), functionName: "arbitrator",
  });
  const arbitrator = new ArcBountyAgent({
    privateKey: ARBITRATOR_PK!, rpcUrl: network.rpcUrl, bountyAdapterAddress: adapter, network: networkName,
  });
  const meta = await arbitrator.getBounty(jobId);
  const reward = `${(Number(meta.reward) / 1e6).toFixed(2)} USDC`;

  console.log(`network: ${networkName} (chain ${network.chainId})  adapter: ${adapter}`);
  console.log(`bounty #${jobId}: ${reward}  poster=${meta.poster}  worker=${meta.assignedProvider}`);
  console.log(`dispute: raised by ${meta.disputeInitiator} at ${meta.disputeRaisedAt > 0n ? iso(meta.disputeRaisedAt) : "-"}`);
  console.log(`  claim:    ${meta.disputeReasonHash || "-"}`);
  console.log(`  response: ${meta.disputeResponseHash || "-"}`);
  console.log(`ruling as ${arbitratorAddr}: ${payProvider ? `pay the worker (${reward} minus the 1% fee)` : `refund the poster (${reward})`}`);
  console.log(`ruling text: ${ruling}\n`);

  const refuse = (why: string) => { console.error(`Refusing: ${why}`); process.exit(1); };
  if (onChainArbitrator.toLowerCase() !== arbitratorAddr.toLowerCase()) {
    refuse(`the adapter's arbitrator is ${onChainArbitrator}, not this key (${arbitratorAddr}).`);
  }
  if (meta.resolved) refuse(`#${jobId} is already resolved.`);
  if (!meta.inDispute) refuse(`#${jobId} is not in dispute.`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type yes to ${payProvider ? "pay the worker" : "refund the poster"} on #${jobId}: `)).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") {
    console.log("Stopped. Nothing sent.");
    return;
  }

  const res = await arbitrator.resolveDispute(jobId, payProvider, { text: ruling }, 0);
  console.log(`resolveDispute: ${res.hash}`);
  console.log(payProvider ? `${reward} released to ${meta.assignedProvider}, minus the 1% fee.` : `${reward} returned to ${meta.poster}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
