/**
 * Create the arbitrator Safe on Arc mainnet - the same SafeL2 v1.4.1
 * configuration, owners, threshold and salt as BaseBounty's Safe, which lands
 * it on the same address: the canonical SafeProxyFactory and its proxy
 * creation code are byte-identical on Arc (5042) and Base (8453), checked
 * 2026-09-16. Deployed through the factory rather than app.safe.global, which
 * does not list Arc mainnet yet.
 *
 * Owners are NOT hardcoded - PRE_MAINNET_RUNBOOK.md §9 says the mainnet signer
 * set is a decision. EXPECTED_SAFE pins the address the run must produce, so a
 * reordered or mistyped owner list aborts before broadcasting instead of
 * creating a second, different Safe.
 *
 * Safety: refuses to run unless the RPC really is Arc mainnet, the three
 * canonical Safe contracts have code, and the owner list is well-formed.
 * Always simulates first and prints the address the Safe will land on;
 * DRY_RUN=1 stops there without broadcasting. If a Safe already sits at the
 * predicted address, reports it and exits without sending anything.
 *
 * Env (root .env):
 *   PRIVATE_KEY          - pays gas only; NOT automatically an owner
 *   SAFE_OWNERS          - comma-separated owner addresses, in order
 *   SAFE_THRESHOLD       - signatures required (default 2)
 *   SAFE_SALT            - saltNonce, default 0
 *   EXPECTED_SAFE        - optional: abort unless the predicted address matches
 *   ARC_MAINNET_RPC_URL  - optional RPC override
 *
 * Usage: cd scripts && DRY_RUN=1 npx tsx safe-create-arc.ts
 */

import {
  createWalletClient, createPublicClient, http, encodeFunctionData,
  getAddress, isAddress, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveNetwork } from "../agent-sdk/src/constants.js";
import { buildChain } from "./lib/network.js";

const network = resolveNetwork("arc-mainnet");
const chain = buildChain(network);
const PK = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const DRY_RUN = process.env.DRY_RUN === "1";

// Canonical Safe v1.4.1 deployments - identical addresses on Arc and Base.
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
    throw new Error("SAFE_OWNERS contains duplicates - Safe.setup reverts on a repeated owner");
  }
  if (owners.some(o => o === ZERO)) throw new Error("SAFE_OWNERS contains the zero address");
  return owners;
}

async function main() {
  if (!PK) throw new Error("Missing env: PRIVATE_KEY");

  const owners = parseOwners(process.env.SAFE_OWNERS);
  const threshold = BigInt(process.env.SAFE_THRESHOLD ?? "2");
  const saltNonce = BigInt(process.env.SAFE_SALT ?? "0");
  if (threshold < 1n || threshold > BigInt(owners.length)) {
    throw new Error(`SAFE_THRESHOLD=${threshold} is out of range for ${owners.length} owner(s)`);
  }
  const expectedRaw = process.env.EXPECTED_SAFE?.trim();
  if (expectedRaw && !isAddress(expectedRaw)) throw new Error(`EXPECTED_SAFE="${expectedRaw}" is not an address`);

  const account = privateKeyToAccount(PK);
  const pub = createPublicClient({ chain, transport: http(network.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(network.rpcUrl) });

  const chainId = await pub.getChainId();
  if (chainId !== network.chainId) {
    throw new Error(`ABORT: RPC reports chainId ${chainId}, expected ${network.chainId} (Arc mainnet)`);
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
  console.log("chain:      Arc mainnet (5042)  rpc: %s", network.rpcUrl);
  // Native USDC has 18 decimals on Arc (the ERC-20 view has 6).
  console.log("payer:      %s  (%s USDC)", account.address, (Number(balance) / 1e18).toFixed(6));
  console.log("owners:     %s", owners.join(", "));
  console.log("threshold:  %d of %d", Number(threshold), owners.length);
  console.log("saltNonce:  %s", saltNonce.toString());
  if (!owners.some(o => o.toLowerCase() === account.address.toLowerCase())) {
    console.log("note:       the payer is NOT an owner - it only pays gas.");
  }

  const initializer = encodeFunctionData({
    abi: SAFE_ABI, functionName: "setup",
    args: [owners, threshold, ZERO, "0x", FALLBACK_HANDLER, ZERO, 0n, ZERO],
  });

  let predicted: Address;
  let request;
  try {
    const sim = await pub.simulateContract({
      account, address: PROXY_FACTORY, abi: FACTORY_ABI, functionName: "createProxyWithNonce",
      args: [SAFE_L2_SINGLETON, initializer, saltNonce],
    });
    predicted = sim.result as Address;
    request = sim.request;
  } catch (err) {
    // CREATE2 collides when this exact Safe already exists - the case where a
    // previous run already did the job. Say so plainly rather than dump a revert.
    if (expectedRaw && String(err).includes("Create2 call failed")) {
      const code = await pub.getCode({ address: getAddress(expectedRaw) });
      if (code && code !== "0x") {
        console.log(`\nA contract already sits at EXPECTED_SAFE ${getAddress(expectedRaw)} - nothing to do.`);
        return;
      }
    }
    throw err;
  }
  console.log("predicted Safe address:", predicted);
  if (expectedRaw && predicted.toLowerCase() !== expectedRaw.toLowerCase()) {
    throw new Error(
      `ABORT: this configuration lands on ${predicted}, not EXPECTED_SAFE ${getAddress(expectedRaw)}. ` +
      "Check the owner order, threshold and salt - nothing was broadcast.",
    );
  }

  if (balance === 0n) {
    // Nodes refuse eth_estimateGas from an empty account ("gas required exceeds
    // allowance (0)"), so a dry run can still prove the address but not the cost.
    console.log(`payer holds 0 USDC on Arc mainnet - fund ${account.address} before broadcasting.`);
    if (DRY_RUN) console.log("DRY_RUN=1 - nothing broadcast.");
    return;
  }

  if (DRY_RUN) {
    const gas = await pub.estimateContractGas({
      account, address: PROXY_FACTORY, abi: FACTORY_ABI, functionName: "createProxyWithNonce",
      args: [SAFE_L2_SINGLETON, initializer, saltNonce],
    });
    const gasPrice = await pub.getGasPrice();
    console.log("estimated gas: %s  (~%s USDC at %s gwei)",
      gas.toString(), (Number(gas * gasPrice) / 1e18).toFixed(6), (Number(gasPrice) / 1e9).toFixed(4));
    console.log("DRY_RUN=1 - nothing broadcast.");
    return;
  }

  const hash = await wallet.writeContract(request);
  console.log("createProxyWithNonce tx:", hash);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log("status: %s  block: %s  gasUsed: %s",
    receipt.status, receipt.blockNumber.toString(), receipt.gasUsed.toString());
  if (receipt.status !== "success") throw new Error("ABORT: proxy creation reverted");

  const [onchainOwners, onchainThreshold, version] = await Promise.all([
    pub.readContract({ address: predicted, abi: SAFE_ABI, functionName: "getOwners" }),
    pub.readContract({ address: predicted, abi: SAFE_ABI, functionName: "getThreshold" }),
    pub.readContract({ address: predicted, abi: SAFE_ABI, functionName: "VERSION" }),
  ]);
  console.log("\nSafe deployed: %s (v%s)", predicted, version);
  console.log("owners:    %s", (onchainOwners as readonly Address[]).join(", "));
  console.log("threshold: %s", (onchainThreshold as bigint).toString());

  const sameOwners =
    (onchainOwners as readonly Address[]).length === owners.length &&
    owners.every(o => (onchainOwners as readonly Address[]).some(x => x.toLowerCase() === o.toLowerCase()));
  if (!sameOwners || (onchainThreshold as bigint) !== threshold) {
    throw new Error("ABORT: on-chain owner set/threshold does not match what was requested");
  }
  console.log("verified: on-chain owners and threshold match the request.");
}

main().catch(err => { console.error(err); process.exit(1); });
