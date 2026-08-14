/**
 * Create the mainnet arbitrator Safe on Base — the same SafeL2 v1.4.1
 * configuration Arc runs (singleton 0x29fcB4…C762, CompatibilityFallbackHandler
 * 0xfd0732…Ec99, both verified live on Base at chainId 8453), deployed through
 * the canonical SafeProxyFactory rather than app.safe.global. The resulting
 * Safe is an ordinary canonical Safe: it shows up in the Safe web app and can
 * be signed from MetaMask exactly like the Arc one.
 *
 * Owners are deliberately NOT hardcoded — PRE_MAINNET_RUNBOOK.md §9 says the
 * mainnet signer set is a decision, not a carry-over from testnet.
 *
 * Safety: refuses to run unless the RPC really is Base mainnet, the three
 * canonical Safe contracts have code, and the owner list is well-formed
 * (distinct, non-zero, checksummed). Always simulates first and prints the
 * address the Safe will land on; DRY_RUN=1 stops there without broadcasting.
 *
 * Env (root .env):
 *   BASE_MAINNET_DEPLOYER_KEY — pays gas only; NOT automatically an owner
 *   SAFE_OWNERS               — comma-separated owner addresses
 *   SAFE_THRESHOLD            — signatures required (default 2)
 *   SAFE_SALT                 — saltNonce, default 0 (bump only on collision)
 *   BASE_MAINNET_RPC_URL      — optional RPC override
 *
 * Usage: cd scripts && DRY_RUN=1 npx tsx safe-create-base.ts
 */

import {
  createWalletClient, createPublicClient, http, encodeFunctionData,
  getAddress, isAddress, type Address,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";
const PK = process.env.BASE_MAINNET_DEPLOYER_KEY as `0x${string}` | undefined;
const DRY_RUN = process.env.DRY_RUN === "1";

// Canonical Safe v1.4.1 deployments — identical addresses on Arc and Base.
const PROXY_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address;
const SAFE_L2_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as Address;
const FALLBACK_HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const FACTORY_ABI = [
  {
    name: "createProxyWithNonce", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
] as const;

const SAFE_ABI = [
  {
    name: "setup", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
  { name: "getOwners", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { name: "getThreshold", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "VERSION", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

function parseOwners(raw: string | undefined): Address[] {
  if (!raw?.trim()) throw new Error("Missing env: SAFE_OWNERS (comma-separated owner addresses)");
  const owners = raw.split(",").map(s => s.trim()).filter(Boolean).map(s => {
    if (!isAddress(s)) throw new Error(`SAFE_OWNERS contains "${s}", which is not a valid address`);
    return getAddress(s);
  });
  if (owners.length === 0) throw new Error("SAFE_OWNERS is empty");
  if (new Set(owners.map(o => o.toLowerCase())).size !== owners.length) {
    throw new Error("SAFE_OWNERS contains duplicates — Safe.setup reverts on a repeated owner");
  }
  if (owners.some(o => o === ZERO)) throw new Error("SAFE_OWNERS contains the zero address");
  return owners;
}

async function main() {
  if (!PK) throw new Error("Missing env: BASE_MAINNET_DEPLOYER_KEY");

  const owners = parseOwners(process.env.SAFE_OWNERS);
  const threshold = BigInt(process.env.SAFE_THRESHOLD ?? "2");
  const saltNonce = BigInt(process.env.SAFE_SALT ?? "0");
  if (threshold < 1n || threshold > BigInt(owners.length)) {
    throw new Error(`SAFE_THRESHOLD=${threshold} is out of range for ${owners.length} owner(s)`);
  }

  const account = privateKeyToAccount(PK);
  const pub = createPublicClient({ chain: base, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });

  const chainId = await pub.getChainId();
  if (chainId !== base.id) {
    throw new Error(`ABORT: RPC reports chainId ${chainId}, expected ${base.id} (Base mainnet)`);
  }
  for (const [label, addr] of [
    ["SafeProxyFactory 1.4.1", PROXY_FACTORY],
    ["SafeL2 1.4.1 singleton", SAFE_L2_SINGLETON],
    ["CompatibilityFallbackHandler 1.4.1", FALLBACK_HANDLER],
  ] as const) {
    const code = await pub.getCode({ address: addr });
    if (!code || code === "0x") throw new Error(`ABORT: ${label} has no code at ${addr} on chain ${chainId}`);
  }

  const balance = await pub.getBalance({ address: account.address });
  console.log("chain:      Base mainnet (8453)");
  console.log("payer:      %s  (%s ETH)", account.address, (Number(balance) / 1e18).toFixed(6));
  console.log("owners:     %s", owners.join(", "));
  console.log("threshold:  %d of %d", Number(threshold), owners.length);
  console.log("saltNonce:  %s", saltNonce.toString());
  if (!owners.some(o => o.toLowerCase() === account.address.toLowerCase())) {
    console.log("note:       the deployer is NOT an owner — it only pays gas.");
  }

  const initializer = encodeFunctionData({
    abi: SAFE_ABI, functionName: "setup",
    args: [owners, threshold, ZERO, "0x", FALLBACK_HANDLER, ZERO, 0n, ZERO],
  });

  const { request, result: predicted } = await pub.simulateContract({
    account, address: PROXY_FACTORY, abi: FACTORY_ABI, functionName: "createProxyWithNonce",
    args: [SAFE_L2_SINGLETON, initializer, saltNonce],
  });
  console.log("predicted Safe address:", predicted);

  if (DRY_RUN) {
    const gas = await pub.estimateContractGas({
      account, address: PROXY_FACTORY, abi: FACTORY_ABI, functionName: "createProxyWithNonce",
      args: [SAFE_L2_SINGLETON, initializer, saltNonce],
    });
    const gasPrice = await pub.getGasPrice();
    console.log("estimated gas: %s  (~%s ETH at %s gwei)",
      gas.toString(), (Number(gas * gasPrice) / 1e18).toFixed(8), (Number(gasPrice) / 1e9).toFixed(4));
    console.log("DRY_RUN=1 — nothing broadcast.");
    return;
  }

  const hash = await wallet.writeContract(request);
  console.log("createProxyWithNonce tx:", hash);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log("status: %s  block: %s  gasUsed: %s",
    receipt.status, receipt.blockNumber.toString(), receipt.gasUsed.toString());
  if (receipt.status !== "success") throw new Error("ABORT: proxy creation reverted");

  const safe = predicted as Address;
  // https://mainnet.base.org is load-balanced: a read issued right after the
  // receipt can land on a node that hasn't caught up to that block yet and
  // come back "returned no data" for a contract that demonstrably exists.
  const readBack = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  };
  const [onchainOwners, onchainThreshold, version] = await Promise.all([
    readBack(() => pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" })),
    readBack(() => pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" })),
    readBack(() => pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "VERSION" })),
  ]);
  console.log("\nSafe deployed: %s (v%s)", safe, version);
  console.log("owners:    %s", (onchainOwners as readonly Address[]).join(", "));
  console.log("threshold: %s", (onchainThreshold as bigint).toString());
  console.log("app.safe.global: https://app.safe.global/home?safe=base:%s", safe);

  const sameOwners =
    (onchainOwners as readonly Address[]).length === owners.length &&
    owners.every(o => (onchainOwners as readonly Address[]).some(x => x.toLowerCase() === o.toLowerCase()));
  if (!sameOwners || (onchainThreshold as bigint) !== threshold) {
    throw new Error("ABORT: on-chain owner set/threshold does not match what was requested");
  }
  console.log("verified: on-chain owners and threshold match the request.");
}

main().catch(err => { console.error(err); process.exit(1); });
