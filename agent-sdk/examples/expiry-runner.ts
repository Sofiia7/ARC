/**
 * ArcBounty expiry-runner — the single off-chain maintenance task in the system.
 *
 * Walks the open bounty list, identifies entries whose deadline has passed without
 * a submission, and calls `expireBounty(jobId)` so the poster's USDC is refunded.
 *
 * Permissionless: anyone can run this. We recommend running it as:
 *  - a Vercel Cron (every 10 minutes), OR
 *  - a Railway / Fly.io worker with a loop, OR
 *  - a GitHub Action with `schedule: cron`.
 *
 * The runner pays a tiny amount of USDC in gas (~$0.005 per expireBounty call).
 * For a community to fund a public runner, set EXPIRY_RUNNER_PRIVATE_KEY in a
 * shared low-value hot wallet topped up periodically.
 *
 * Usage:
 *   tsx examples/expiry-runner.ts             # one pass, exits
 *   LOOP=1 INTERVAL_SEC=600 tsx examples/expiry-runner.ts  # forever-loop
 */

import { ArcBountyAgent } from "../src/index.js";

const PRIVATE_KEY        = process.env["EXPIRY_RUNNER_PRIVATE_KEY"] as `0x${string}` | undefined;
const RPC_URL            = process.env["ARC_TESTNET_RPC_URL"];
const BOUNTY_ADAPTER     = process.env["BOUNTY_ADAPTER_ADDRESS"] as `0x${string}` | undefined;
const LOOP               = process.env["LOOP"] === "1";
const INTERVAL_SEC       = Number(process.env["INTERVAL_SEC"] ?? "600");
const SCAN_LIMIT         = Number(process.env["SCAN_LIMIT"] ?? "200");

if (!PRIVATE_KEY) {
  console.error("EXPIRY_RUNNER_PRIVATE_KEY missing");
  process.exit(1);
}

async function runOnce(): Promise<void> {
  const agent = new ArcBountyAgent({
    privateKey: PRIVATE_KEY!,
    rpcUrl: RPC_URL,
    bountyAdapterAddress: BOUNTY_ADAPTER,
  });

  const started = Date.now();
  const expired = await agent.expireStale("", SCAN_LIMIT);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (expired.length === 0) {
    console.log(`[expiry-runner] ${new Date().toISOString()} — nothing to expire (${elapsed}s)`);
  } else {
    console.log(`[expiry-runner] ${new Date().toISOString()} — expired ${expired.length} bounty/-ies in ${elapsed}s: ${expired.join(", ")}`);
  }
}

async function main(): Promise<void> {
  if (!LOOP) {
    await runOnce();
    return;
  }
  // Forever loop. Crashes restart from process supervisor (systemd/pm2/railway).
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      console.error("[expiry-runner] error:", e);
    }
    await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
