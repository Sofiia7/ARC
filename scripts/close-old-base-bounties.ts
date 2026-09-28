/**
 * Close what is left on BaseBounty's superseded V4.6 adapter (0x9b0B…4c2c)
 * after the V4.7 cutover of 2026-09-28. basebounty.app reads only V4.7 now,
 * so these two are closed from here:
 *   #3  in dispute: the worker challenged our rejection and we never answered
 *       within 48 h, so claimDefaultRuling pays the worker (the reward minus
 *       the 1% fee). Anyone may call it.
 *   #4  taken, nothing submitted: expireBounty refunds the poster, but the
 *       contract allows it only after the deadline (2026-11-26); until then
 *       the worker still has the right to submit.
 * Close both before V4.6's C-02 window opens for them (their deadline). Every
 * call is simulated first and asks for yes. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   npx tsx --env-file=..\.env close-old-base-bounties.ts           asks yes per bounty
 *   npx tsx --env-file=..\.env close-old-base-bounties.ts --check   shows what can be closed, sends nothing
 * Reads BASE_MAINNET_DEPLOYER_KEY (it only pays the gas).
 */
// First, before anything touches the network: a dead router DNS must not stop this.
import "./lib/dns-fallback.js";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { ArcBountyAgent } from "arcbounty-agent-sdk";

const RPC = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://mainnet.base.org";
const OLD_ADAPTER: Address = "0x9b0B27c20DF10BFc667F4316d7175166Ff8c4c2c";
const JOBS = [3n, 4n];
const CHECK_ONLY = process.argv.includes("--check");

const ABI = parseAbi([
  "function claimDefaultRuling(uint256 jobId)",
  "function expireBounty(uint256 jobId)",
]);

async function main() {
  const key = process.env.BASE_MAINNET_DEPLOYER_KEY?.trim() as Hex | undefined;
  if (!key) throw new Error("Missing BASE_MAINNET_DEPLOYER_KEY. Run it with --env-file=..\\.env (see the header).");
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain: base, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });
  const reader = new ArcBountyAgent({ privateKey: key, network: "base-mainnet", rpcUrl: RPC, bountyAdapterAddress: OLD_ADAPTER });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const rl = CHECK_ONLY ? null : createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (const jobId of JOBS) {
      const m = await reader.getBounty(jobId);
      const reward = `${formatUnits(m.reward, 6)} USDC`;
      const deadline = new Date(Number(m.deadline) * 1000).toISOString().slice(0, 10);
      console.log(`\n#${jobId}  ${reward}  worker ${m.assignedProvider}  deadline ${deadline}`);
      if (m.resolved) {
        console.log("  already closed");
        continue;
      }
      const fn: "claimDefaultRuling" | "expireBounty" | null =
        m.inDispute ? "claimDefaultRuling"
        : m.isTaken && !m.submittedResultHash && now > m.deadline ? "expireBounty"
        : null;
      if (!fn) {
        console.log(m.submittedResultHash
          ? "  work was submitted: it waits for review on the old adapter, nothing to close here"
          : `  taken, nothing submitted: the contract allows closing it only after ${deadline}; run this again then`);
        continue;
      }
      const effect = fn === "claimDefaultRuling"
        ? `the dispute's default ruling: the worker gets the ${reward} reward minus the 1% fee`
        : `expiry: the ${reward} reward goes back to the poster ${m.poster}`;
      try {
        await pub.simulateContract({ address: OLD_ADAPTER, abi: ABI, functionName: fn, args: [jobId], account });
      } catch (err) {
        console.log(`  ${fn} would revert: ${(err as { shortMessage?: string }).shortMessage ?? String(err)}`);
        continue;
      }
      console.log(`  can be closed now by ${effect}`);
      if (!rl) continue;
      if ((await rl.question(`  Type yes to call ${fn}(${jobId}): `)).trim().toLowerCase() !== "yes") {
        console.log("  skipped");
        continue;
      }
      const hash = await wallet.writeContract({ address: OLD_ADAPTER, abi: ABI, functionName: fn, args: [jobId] });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      console.log(receipt.status === "success" ? `  closed: https://basescan.org/tx/${hash}` : `  reverted: https://basescan.org/tx/${hash}`);
    }
  } finally {
    rl?.close();
  }
  if (CHECK_ONLY) console.log("\n--check: nothing sent.");
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
