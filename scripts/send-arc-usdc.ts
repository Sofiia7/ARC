/**
 * Send a little native USDC on Arc mainnet from the deployer wallet (PRIVATE_KEY), for gas.
 *
 * Made for the arbitrator Safe handoff: none of the Safe's three owners held any
 * USDC on Arc on 2026-09-17, and on arcbounty.app/safe the wallet that presses
 * Execute pays the gas (about 0.004 USDC). Capped at 1 USDC per run, refuses a
 * contract or zero recipient, and asks for yes before sending. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   npx tsx send-arc-usdc.ts <to> <amount>
 */
// First, before anything touches the network: a dead router DNS must not stop this.
import "./lib/dns-fallback.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, http, isAddress, formatEther, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveNetwork } from "../agent-sdk/src/constants.js";
import { buildChain } from "./lib/network.js";

const MAX_USDC = parseEther("1");
const GAS_RESERVE = parseEther("0.02");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[m[1]!] = value;
  }
  return out;
}

async function main() {
  const [toArg, amountArg] = process.argv.slice(2);
  if (!toArg || !isAddress(toArg) || !amountArg || !/^\d+(\.\d{1,18})?$/.test(amountArg)) {
    throw new Error("Usage: npx tsx send-arc-usdc.ts <to address> <amount in USDC, e.g. 0.1>");
  }
  const to = toArg as Address;
  const value = parseEther(amountArg);
  if (value === 0n || value > MAX_USDC) throw new Error("ABORT: the amount must be above 0 and at most 1 USDC");
  if (/^0x0{40}$/i.test(to)) throw new Error("ABORT: the zero address");

  const key = (process.env["PRIVATE_KEY"]?.trim() || readDotEnv(join(ROOT, ".env"))["PRIVATE_KEY"]) as Hex | undefined;
  if (!key) throw new Error("Missing PRIVATE_KEY in the root .env");

  const network = resolveNetwork("arc-mainnet");
  const chain = buildChain(network);
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain, transport: http(network.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(network.rpcUrl) });

  if ((await pub.getChainId()) !== network.chainId) throw new Error(`ABORT: the RPC is not chain ${network.chainId}`);
  const code = await pub.getCode({ address: to });
  if (code && code !== "0x") throw new Error(`ABORT: ${to} is a contract; this script only tops up wallets`);

  const [fromBalance, toBalance] = await Promise.all([
    pub.getBalance({ address: account.address }),
    pub.getBalance({ address: to }),
  ]);
  console.log(`from  ${account.address}  ${formatEther(fromBalance)} USDC`);
  console.log(`to    ${to}  ${formatEther(toBalance)} USDC`);
  console.log(`send  ${formatEther(value)} USDC on Arc mainnet`);
  if (fromBalance < value + GAS_RESERVE) throw new Error("ABORT: the deployer cannot cover the amount plus gas");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\nType yes to send ${formatEther(value)} USDC to ${to}: `)).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") {
    console.log("Stopped. Nothing sent.");
    return;
  }

  const hash = await wallet.sendTransaction({ to, value });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transfer reverted: ${hash}`);
  console.log(`sent: https://arcexplorer.org/tx/${hash}`);
  console.log(`${to} now holds ${formatEther(await pub.getBalance({ address: to }))} USDC`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
