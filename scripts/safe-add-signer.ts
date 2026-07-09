/**
 * One-off: add a second owner to the arbitrator Safe and raise the
 * threshold to 2-of-2 (Grant Milestone 1 — real N-of-M, not just
 * infrastructure for it).
 *
 * Safety: before signing anything, this computes the SafeTx hash locally
 * via EIP-712 and cross-checks it against the Safe contract's own
 * getTransactionHash(...) view function. If they don't match, it aborts
 * before ever signing or sending — a mismatched domain/type would just
 * make execTransaction revert (GS026 invalid signature), never a wrong
 * execution, but there's no reason to find that out the hard way.
 *
 * Env: ARC_TESTNET_RPC_URL, PRIVATE_KEY (current sole Safe owner)
 * Usage: cd scripts && npx tsx safe-add-signer.ts
 */

import {
  createWalletClient, createPublicClient, http, encodeFunctionData, hashTypedData,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC  = process.env.ARC_TESTNET_RPC_URL!;
const PK   = process.env.PRIVATE_KEY as `0x${string}`;
const SAFE = "0x4892232f0dD235cC1B92a3A87fc8990553691BC6" as Address;
const NEW_OWNER = "0xed733FC13B1413966cf056866B6d80eF7b490eEc" as Address;
const NEW_THRESHOLD = 2n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

if (!RPC || !PK) {
  console.error("Missing env: ARC_TESTNET_RPC_URL / PRIVATE_KEY");
  process.exit(1);
}

const arc = {
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } },
} as const;

const account = privateKeyToAccount(PK);
const wallet  = createWalletClient({ account, chain: arc, transport: http(RPC) });
const pub     = createPublicClient({ chain: arc, transport: http(RPC) });

const SAFE_ABI = [
  { name: "getOwners", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { name: "getThreshold", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "nonce", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    name: "addOwnerWithThreshold", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "owner", type: "address" }, { name: "_threshold", type: "uint256" }], outputs: [],
  },
  {
    name: "getTransactionHash", type: "function", stateMutability: "view",
    inputs: [
      { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
      { name: "_nonce", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "execTransaction", type: "function", stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

async function main() {
  const owners = await pub.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "getOwners" });
  const threshold = await pub.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "getThreshold" });
  console.log("before: owners =", owners, " threshold =", threshold.toString());

  if (owners.length !== 1 || owners[0]!.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`unexpected Safe state — expected sole owner ${account.address}, got ${JSON.stringify(owners)}`);
  }

  const data = encodeFunctionData({
    abi: SAFE_ABI, functionName: "addOwnerWithThreshold", args: [NEW_OWNER, NEW_THRESHOLD],
  });
  const nonce = await pub.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "nonce" });

  const txParams = {
    to: SAFE, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ZERO, refundReceiver: ZERO, nonce,
  };

  const domain = { chainId: arc.id, verifyingContract: SAFE };
  const types = {
    SafeTx: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  } as const;

  const localHash = hashTypedData({ domain, types, primaryType: "SafeTx", message: txParams });
  const onchainHash = await pub.readContract({
    address: SAFE, abi: SAFE_ABI, functionName: "getTransactionHash",
    args: [txParams.to, txParams.value, txParams.data, txParams.operation, txParams.safeTxGas,
      txParams.baseGas, txParams.gasPrice, txParams.gasToken, txParams.refundReceiver, txParams.nonce],
  });

  console.log("local  safeTxHash:", localHash);
  console.log("onchain safeTxHash:", onchainHash);
  if (localHash.toLowerCase() !== onchainHash.toLowerCase()) {
    throw new Error("ABORT: locally computed EIP-712 hash does not match the Safe's own getTransactionHash — refusing to sign a mismatched tx");
  }
  console.log("hashes match — safe to sign.");

  const signature = await account.signTypedData({ domain, types, primaryType: "SafeTx", message: txParams });

  const hash = await wallet.writeContract({
    address: SAFE, abi: SAFE_ABI, functionName: "execTransaction",
    args: [txParams.to, txParams.value, txParams.data, txParams.operation, txParams.safeTxGas,
      txParams.baseGas, txParams.gasPrice, txParams.gasToken, txParams.refundReceiver, signature],
  });
  console.log("execTransaction tx:", hash);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log("status:", receipt.status, " block:", receipt.blockNumber.toString());

  const newOwners = await pub.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "getOwners" });
  const newThreshold = await pub.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "getThreshold" });
  console.log("after: owners =", newOwners, " threshold =", newThreshold.toString());
}

main().catch(err => { console.error(err); process.exit(1); });
