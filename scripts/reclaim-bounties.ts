/**
 * Reclaim USDC locked in superseded adapter deployments.
 *
 * After a redeploy, open bounties on the old adapter keep the poster's USDC
 * escrowed there forever unless someone cancels/expires them. This walks every
 * historical adapter address, finds bounties posted by PRIVATE_KEY's address,
 * and refunds them:
 *   - not taken            → cancelBounty (full refund, any time)
 *   - taken, no submission → expireBounty (full refund, only after deadline)
 * Anything submitted / disputed / resolved is left alone and reported.
 *
 * Env (same as seed-bounties.ts): PRIVATE_KEY, ARC_TESTNET_RPC_URL.
 * Old adapter list: see contracts/DEPLOYMENTS.md "Historical / abandoned".
 *
 * Usage (from repo root):
 *   cd scripts && npx tsx reclaim-bounties.ts            # dry run (default)
 *   cd scripts && RECLAIM=1 npx tsx reclaim-bounties.ts  # send transactions
 */

import { createWalletClient, createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network";
const PK = process.env.PRIVATE_KEY as `0x${string}`;
const DO_SEND = process.env.RECLAIM === "1";

if (!PK) {
  console.error("Missing env: PRIVATE_KEY");
  process.exit(1);
}

// Superseded deployments (contracts/DEPLOYMENTS.md). V2-and-older lack the
// getMyPostedBounties index and are skipped automatically by the try/catch.
const OLD_ADAPTERS: { label: string; address: Address }[] = [
  { label: "V4.2", address: "0x30C4EC6A846F8F879CAB3de481E3fd3f442e7572" },
  { label: "V4.1", address: "0x83117287A0C1eCBCF33B0F11aD5BD8Ae9F379887" },
  { label: "V4", address: "0xAe9898324256083E8F37D82FEC4be0448A107645" },
  { label: "V3.3", address: "0x90a976bD4edF7cA66F38bF4E8Bf795bA389b4f05" },
  { label: "V3.2", address: "0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83" },
  { label: "V3.1", address: "0x15Fba46C1f5eCc043ebf0E859Ce1e7DC2aa0C679" },
  { label: "V3", address: "0x4AF985AE361354bB28e1c3A9096cB797567D04F3" },
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

const arc = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } },
} as const;

const account = privateKeyToAccount(PK);
const wallet = createWalletClient({ account, chain: arc, transport: http(RPC) });
const pub = createPublicClient({ chain: arc, transport: http(RPC) });

async function main() {
  console.log(`Poster: ${account.address}${DO_SEND ? "" : "  (dry run — set RECLAIM=1 to send)"}`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  let reclaimed = 0n;

  for (const { label, address } of OLD_ADAPTERS) {
    let jobIds: readonly bigint[];
    try {
      jobIds = await pub.readContract({
        address, abi: ABI, functionName: "getMyPostedBounties", args: [account.address],
      });
    } catch {
      console.log(`\n${label} ${address}: no index / unreachable — skipped`);
      continue;
    }
    console.log(`\n${label} ${address}: ${jobIds.length} bounties posted by us`);

    for (const jobId of jobIds) {
      const m = await pub.readContract({
        address, abi: ABI, functionName: "getBountyMeta", args: [jobId],
      });
      if (m.resolved) continue;

      let action: "cancelBounty" | "expireBounty" | null = null;
      if (!m.isTaken) action = "cancelBounty";
      else if (m.submittedResultHash.length === 0 && now > m.deadline) action = "expireBounty";

      if (!action) {
        console.log(`  #${jobId} — active (taken/submitted/disputed), leaving alone`);
        continue;
      }
      console.log(`  #${jobId} — ${action}, refund ${Number(m.reward) / 1e6} USDC`);
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
