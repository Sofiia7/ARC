/**
 * Reclaim USDC that this wallet has left escrowed in bounties nobody can take.
 *
 * Two ways that happens. A redeploy strands open bounties on the old adapter
 * forever unless someone cancels them; and on the live adapter, a listing whose
 * deadline has passed is just as stuck, still holding its reward while
 * disappearing from the board. Both are walked, for bounties posted by
 * PRIVATE_KEY's address:
 *   - superseded adapter, not taken   → cancelBounty (nothing there is
 *                                       reachable, expired or not)
 *   - live adapter, not taken, EXPIRED → cancelBounty
 *   - taken, no submission, expired    → expireBounty
 * Anything submitted / disputed / resolved is left alone and reported.
 *
 * The expiry condition on the live adapter is the whole safety of this script.
 * An untaken bounty that has not expired is not stuck - it is the marketplace.
 * Without that check a run against Arc Testnet would have cancelled all 38 open
 * listings and emptied arcbounty.app, which is exactly what the first version
 * of the live-adapter walk proposed to do.
 *
 * Env (same as seed-bounties.ts): PRIVATE_KEY, plus ARC_NETWORK /
 * ALLOW_MAINNET / ARC_TESTNET_RPC_URL (see scripts/lib/network.ts), and
 * BOUNTY_ADAPTER_ADDRESS if the live adapter is not the network's default.
 * Historical adapter list: contracts/DEPLOYMENTS.md "Historical / abandoned",
 * walked on Arc Testnet only - the other networks have no history yet.
 *
 * Usage (from repo root):
 *   cd scripts && npx tsx reclaim-bounties.ts            # dry run (default)
 *   cd scripts && RECLAIM=1 npx tsx reclaim-bounties.ts  # send transactions
 */

import { createWalletClient, createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireNetworkForMoneyMove, buildChain } from "./lib/network.js";

const network = requireNetworkForMoneyMove();
const arc     = buildChain(network);
const RPC     = network.rpcUrl;
const PK = process.env.PRIVATE_KEY as `0x${string}`;
const DO_SEND = process.env.RECLAIM === "1";

if (!PK) {
  console.error("Missing env: PRIVATE_KEY");
  process.exit(1);
}

// Superseded Arc Testnet deployments (contracts/DEPLOYMENTS.md). V2-and-older
// lack the getMyPostedBounties index and are skipped automatically by the
// try/catch. Only walked on Arc Testnet: on another chain these are addresses
// that mean nothing, and one of them belonging to an unrelated contract there
// is not a call worth making.
const OLD_ADAPTERS: { label: string; address: Address }[] = [
  { label: "V4.3", address: "0x2e9504EEa0bD80CBaA2464227054fc941EE46cA7" },
  { label: "V4.2", address: "0x30C4EC6A846F8F879CAB3de481E3fd3f442e7572" },
  { label: "V4.1", address: "0x83117287A0C1eCBCF33B0F11aD5BD8Ae9F379887" },
  { label: "V4", address: "0xAe9898324256083E8F37D82FEC4be0448A107645" },
  { label: "V3.3", address: "0x90a976bD4edF7cA66F38bF4E8Bf795bA389b4f05" },
  { label: "V3.2", address: "0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83" },
  { label: "V3.1", address: "0x15Fba46C1f5eCc043ebf0E859Ce1e7DC2aa0C679" },
  { label: "V3", address: "0x4AF985AE361354bB28e1c3A9096cB797567D04F3" },
];

const ARC_TESTNET_CHAIN_ID = 5_042_002;

// The live adapter is walked too, which the superseded-only version did not do.
// An expired bounty on the current board is exactly as stuck as one on an old
// deployment, and rather more embarrassing: on Base that was 4 USDC held behind
// a board showing nothing, because every seeded listing had run past its
// deadline. `cancelBounty` on an untaken bounty refunds in full at any time.
const CURRENT_ADAPTER = (process.env.BOUNTY_ADAPTER_ADDRESS ?? network.defaultBountyAdapter) as Address | undefined;

const ADAPTERS: { label: string; address: Address; live: boolean }[] = [
  ...(CURRENT_ADAPTER ? [{ label: "current", address: CURRENT_ADAPTER, live: true }] : []),
  ...(network.chainId === ARC_TESTNET_CHAIN_ID
    ? OLD_ADAPTERS.map(a => ({ ...a, live: false }))
    : []),
];

const ABI = [
  {
    name: "getMyPostedBounties", type: "function", stateMutability: "view",
    inputs: [{ name: "poster", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "getBountyMeta", type: "function", stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "jobId", type: "uint256" },
        { name: "poster", type: "address" },
        { name: "reward", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "ipfsDescHash", type: "string" },
        { name: "category", type: "string" },
        { name: "tags", type: "string[]" },
        { name: "agentId", type: "uint256" },
        { name: "agentOnly", type: "bool" },
        { name: "humanOnly", type: "bool" },
        { name: "whitelistedProvider", type: "address" },
        { name: "assignedProvider", type: "address" },
        { name: "submittedResultHash", type: "string" },
        { name: "submittedAt", type: "uint256" },
        { name: "isTaken", type: "bool" },
        { name: "rejectedAt", type: "uint256" },
        { name: "rejectionReasonHash", type: "string" },
        { name: "inDispute", type: "bool" },
        { name: "resolved", type: "bool" },
        { name: "disputeInitiator", type: "address" },
        { name: "disputeRaisedAt", type: "uint256" },
        { name: "disputeReasonHash", type: "string" },
        { name: "disputeResponseHash", type: "string" },
        { name: "disputeRulingHash", type: "string" },
      ],
    }],
  },
  {
    name: "cancelBounty", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }], outputs: [],
  },
  {
    name: "expireBounty", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }], outputs: [],
  },
] as const;

const account = privateKeyToAccount(PK);
const wallet = createWalletClient({ account, chain: arc, transport: http(RPC) });
const pub = createPublicClient({ chain: arc, transport: http(RPC) });

/**
 * Retry a read a few times before giving up on it.
 *
 * Base's public RPC is rate limited and load balanced, and a single failed
 * `eth_call` used to abort the whole run - which, half way through sending
 * cancellations, leaves the operator guessing which ones went out. Each
 * bounty is independent, so a flaky read should cost that one bounty, not the
 * rest of them.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T | null> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      if (i === attempts) {
        console.log(`  ${label} - read failed after ${attempts} attempts, skipping: ${msg}`);
        return null;
      }
      await new Promise(r => setTimeout(r, 500 * i));
    }
  }
  return null;
}

async function main() {
  console.log(`Poster: ${account.address}${DO_SEND ? "" : "  (dry run - set RECLAIM=1 to send)"}`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  let reclaimed = 0n;

  for (const { label, address, live } of ADAPTERS) {
    let jobIds: readonly bigint[];
    try {
      jobIds = await pub.readContract({
        address, abi: ABI, functionName: "getMyPostedBounties", args: [account.address],
      });
    } catch {
      console.log(`\n${label} ${address}: no index / unreachable - skipped`);
      continue;
    }
    console.log(`\n${label} ${address}: ${jobIds.length} bounties posted by us`);

    for (const jobId of jobIds) {
      const m = await withRetry(`#${jobId}`, () => pub.readContract({
        address, abi: ABI, functionName: "getBountyMeta", args: [jobId],
      }));
      if (!m || m.resolved) continue;

      const expired = now > m.deadline;
      let action: "cancelBounty" | "expireBounty" | null = null;
      if (!m.isTaken) {
        // On a superseded adapter every untaken bounty is stuck, expired or
        // not: nothing reaches that deployment any more. On the LIVE adapter an
        // untaken bounty that has not expired is not stuck at all - it is the
        // board. Cancelling those empties the marketplace, which on Arc would
        // have been all 38 of them.
        if (!live || expired) action = "cancelBounty";
      } else if (m.submittedResultHash.length === 0 && expired) {
        action = "expireBounty";
      }

      if (!action) {
        console.log(
          `  #${jobId} - ${m.isTaken ? "active (taken/submitted/disputed)" : "open and unexpired"}, leaving alone`,
        );
        continue;
      }
      console.log(`  #${jobId} - ${action}, refund ${Number(m.reward) / 1e6} USDC`);
      reclaimed += m.reward;
      if (DO_SEND) {
        try {
          const hash = await wallet.writeContract({
            address, abi: ABI, functionName: action, args: [jobId],
          });
          const rcpt = await pub.waitForTransactionReceipt({ hash });
          console.log(`     tx ${hash} status=${rcpt.status}`);
        } catch (e) {
          console.log(`     FAILED: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
        }
      }
    }
  }

  console.log(`\n${DO_SEND ? "Reclaimed" : "Reclaimable"}: ~${Number(reclaimed) / 1e6} USDC`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
