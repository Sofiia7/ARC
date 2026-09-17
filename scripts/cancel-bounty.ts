/**
 * Cancel an untaken bounty as its poster. The full reward comes back, no fee.
 *
 * The contract allows this only while nobody has taken the bounty, so the
 * check runs right before sending. First used on 2026-09-17 for ArcBounty #9:
 * its title read as "a dollar for connecting a wallet" on the public board.
 * (reclaim-bounties.ts is for stuck listings and only cancels expired ones.)
 *
 * Poster key and adapter resolve exactly as in approve-bounty.ts. Asks for yes
 * before sending. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   set "ARC_NETWORK=arc-mainnet" && set "ALLOW_MAINNET=yes" && npx tsx --env-file=..\.env cancel-bounty.ts <jobId>
 */

import { ArcBountyAgent } from "arcbounty-agent-sdk";
import { createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createInterface } from "node:readline/promises";
import { getNetworkName, requireNetworkForMoneyMove } from "./lib/network.js";

const network     = requireNetworkForMoneyMove();
const networkName = getNetworkName();

const POSTER_PK = (process.env.POSTER_PRIVATE_KEY
  ?? (networkName === "base-mainnet" ? process.env.BASE_MAINNET_DEPLOYER_KEY : undefined)
  ?? process.env.PRIVATE_KEY) as `0x${string}` | undefined;

const [jobIdArg] = process.argv.slice(2);

if (!POSTER_PK) {
  console.error("Missing env: POSTER_PRIVATE_KEY / BASE_MAINNET_DEPLOYER_KEY / PRIVATE_KEY");
  process.exit(1);
}
if (!jobIdArg || !/^\d+$/.test(jobIdArg)) {
  console.error("Usage: npx tsx --env-file=..\\.env cancel-bounty.ts <jobId>");
  process.exit(1);
}

const jobId = BigInt(jobIdArg);

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

  console.log(`network: ${networkName} (chain ${network.chainId})  adapter: ${adapter}`);
  console.log(`bounty #${jobId}: ${reward}  poster=${meta.poster}  taken=${meta.isTaken}  resolved=${meta.resolved}`);
  console.log(`cancelling as: ${posterAddr}\n`);

  const refuse = (why: string) => { console.error(`Refusing: ${why}`); process.exit(1); };
  if (meta.poster.toLowerCase() !== posterAddr.toLowerCase()) refuse(`#${jobId} was posted by ${meta.poster}, not ${posterAddr}.`);
  if (meta.resolved) refuse(`#${jobId} is already resolved.`);
  if (meta.isTaken) refuse(`#${jobId} is already taken by ${meta.assignedProvider}; a taken bounty cannot be cancelled.`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type yes to cancel #${jobId} and take back ${reward}: `)).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") {
    console.log("Stopped. Nothing sent.");
    return;
  }

  const res = await poster.cancelBounty(jobId);
  console.log(`cancel: ${res.hash}`);
  console.log(`${reward} goes back to ${meta.poster}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
