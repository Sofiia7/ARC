/**
 * The deployer's two calls after the Base V4.7 adapter is deployed
 * (PRE_MAINNET_RUNBOOK.md, Base checklist steps 7 and 8):
 *   1. transferArbitrator(Safe): the Safe then calls acceptArbitrator() in
 *      app.safe.global (Base, 2 of 3). Until it does, the deployer stays the
 *      arbitrator, exactly as on the V4.6 adapter today.
 *   2. setPaused(false): the adapter deploys paused and takes no new bounties
 *      until this call.
 * The address comes from forge's broadcast receipt of MigrateBaseMainnet.s.sol
 * (or pass it as the first argument). Every call asks for yes first. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   npx tsx --env-file=..\.env finish-base-migration.ts
 * Reads BASE_MAINNET_DEPLOYER_KEY.
 */
// First, before anything touches the network: a dead router DNS must not stop this.
import "./lib/dns-fallback.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, http, isAddress, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://mainnet.base.org";
const SAFE: Address = "0x74678c072Ca546f11466CD44eB7e21730a312a54";
const AGENTIC_COMMERCE: Address = "0x6D9317eC0Fca3aFd5439d539064DBA94197c4AC4";
const HERE = dirname(fileURLToPath(import.meta.url));
const RECEIPT = join(HERE, "..", "contracts", "broadcast", "MigrateBaseMainnet.s.sol", "8453", "run-latest.json");

const ABI = parseAbi([
  "function owner() view returns (address)",
  "function arbitrator() view returns (address)",
  "function pendingArbitrator() view returns (address)",
  "function agenticCommerce() view returns (address)",
  "function paused() view returns (bool)",
  "function transferArbitrator(address next)",
  "function setPaused(bool p)",
]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function adapterAddress(): Address {
  const arg = process.argv[2];
  if (arg) {
    if (!isAddress(arg)) throw new Error(`Not an address: ${arg}`);
    return arg;
  }
  if (!existsSync(RECEIPT)) throw new Error(`No broadcast receipt at ${RECEIPT}; pass the new adapter's address.`);
  const log = JSON.parse(readFileSync(RECEIPT, "utf8")) as {
    transactions: { transactionType: string; contractName?: string; contractAddress?: string }[];
  };
  const created = log.transactions.find(t => t.transactionType === "CREATE" && t.contractName === "BountyAdapter");
  if (!created?.contractAddress) throw new Error("The broadcast receipt holds no BountyAdapter deploy.");
  return created.contractAddress as Address;
}

async function main() {
  const key = process.env.BASE_MAINNET_DEPLOYER_KEY?.trim() as Hex | undefined;
  if (!key) throw new Error("Missing BASE_MAINNET_DEPLOYER_KEY. Run it with --env-file=..\\.env (see the header).");
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain: base, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });
  const adapter = adapterAddress();

  const read = async () => ({
    owner: await pub.readContract({ address: adapter, abi: ABI, functionName: "owner" }),
    arbitrator: await pub.readContract({ address: adapter, abi: ABI, functionName: "arbitrator" }),
    pending: await pub.readContract({ address: adapter, abi: ABI, functionName: "pendingArbitrator" }),
    escrow: await pub.readContract({ address: adapter, abi: ABI, functionName: "agenticCommerce" }),
    paused: await pub.readContract({ address: adapter, abi: ABI, functionName: "paused" }),
  });
  let s = await read();
  console.log(`adapter     ${adapter}`);
  console.log(`owner       ${s.owner}`);
  console.log(`arbitrator  ${s.arbitrator}${s.pending !== "0x0000000000000000000000000000000000000000" ? `  (pending: ${s.pending})` : ""}`);
  console.log(`escrow      ${s.escrow}`);
  console.log(`paused      ${s.paused}\n`);
  if (!same(s.escrow, AGENTIC_COMMERCE)) throw new Error(`This adapter talks to ${s.escrow}, not BaseBounty's escrow. Stopped.`);
  if (!same(s.owner, account.address)) throw new Error(`The owner is ${s.owner}, not this key (${account.address}). Stopped.`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string) => (await rl.question(q)).trim().toLowerCase() === "yes";
  const send = async (label: string, request: Parameters<typeof wallet.writeContract>[0]) => {
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted: https://basescan.org/tx/${hash}`);
    console.log(`${label}: https://basescan.org/tx/${hash}\n`);
  };
  try {
    if (same(s.arbitrator, SAFE)) {
      console.log("The Safe is already the arbitrator.");
    } else if (same(s.pending, SAFE)) {
      console.log("The handoff to the Safe is already started; it waits for acceptArbitrator() from the Safe.");
    } else if (same(s.arbitrator, account.address) && await ask(`Type yes to hand the arbitrator role to the Safe ${SAFE}: `)) {
      await send("transferArbitrator(Safe)", { address: adapter, abi: ABI, functionName: "transferArbitrator", args: [SAFE], account, chain: base });
    }

    s = await read();
    if (!s.paused) {
      console.log("The adapter is already open for new bounties.");
    } else if (await ask("Type yes to open the adapter for new bounties (setPaused(false)): ")) {
      await send("setPaused(false)", { address: adapter, abi: ABI, functionName: "setPaused", args: [false], account, chain: base });
    }
  } finally {
    rl.close();
  }

  s = await read();
  console.log(`now: arbitrator ${s.arbitrator}, pending ${s.pending}, paused ${s.paused}`);
  if (!same(s.arbitrator, SAFE)) {
    console.log(`\nLast step, in app.safe.global on Base, Safe ${SAFE}:`);
    console.log(`New transaction > Transaction Builder, address ${adapter}, method acceptArbitrator(); two owners sign, then execute.`);
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
