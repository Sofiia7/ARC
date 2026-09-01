/**
 * Fund the worker wallet (AGENT_PRIVATE_KEY) so it can actually act as an
 * agent on a network where gas is not USDC.
 *
 * Why this exists: on Arc a wallet holding USDC can transact, because USDC is
 * the native gas token. On Base it cannot - gas is ETH and USDC is an ordinary
 * ERC-20, so a worker wallet that has never been topped up with ETH fails at
 * its very first transaction. That is the single reason every end-to-end run
 * on Base so far was done from one wallet: the deployer was the only address
 * on 8453 with any ETH, so it had to be both poster and worker, which makes
 * the payout a self-payment and the reputation write meaningless.
 *
 * What it sends, to AGENT_PRIVATE_KEY's address:
 *   - gas    : FUND_GAS (default 0.0003 ETH on Base) - covers register +
 *              approve + take + submit several times over at Base gas prices
 *   - bond   : FUND_USDC (default 0.5 USDC) - the V4 worker bond for a 1 USDC
 *              bounty is max(MIN_WORKER_BOND, 15% of reward) = 0.5 USDC, and
 *              it is refunded to the worker at submitWork
 *
 * The sender is the network's poster wallet (BASE_MAINNET_DEPLOYER_KEY on Base
 * mainnet, PRIVATE_KEY elsewhere), overridable with POSTER_PRIVATE_KEY - the
 * same resolution agent-proof-of-life.ts uses, so the two scripts cannot
 * disagree about which wallet is which.
 *
 * Skips either leg that is already funded, so it is safe to re-run.
 *
 * Usage (from scripts/):
 *   ARC_NETWORK=base-mainnet ALLOW_MAINNET=yes \
 *     npx tsx --env-file=../.env fund-agent-wallet.ts
 */

import {
  createPublicClient, createWalletClient, http, erc20Abi,
  formatEther, formatUnits, parseEther, parseUnits, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildChain, getNetworkName, requireNetworkForMoneyMove } from "./lib/network.js";

const network     = requireNetworkForMoneyMove();
const networkName = getNetworkName();
const chain       = buildChain(network);

const SENDER_PK = (process.env.POSTER_PRIVATE_KEY
  ?? (networkName === "base-mainnet" ? process.env.BASE_MAINNET_DEPLOYER_KEY : undefined)
  ?? process.env.PRIVATE_KEY) as `0x${string}` | undefined;
const WORKER_PK = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;

if (!SENDER_PK || !WORKER_PK) {
  console.error("Missing env: a sender key (POSTER_PRIVATE_KEY / BASE_MAINNET_DEPLOYER_KEY / PRIVATE_KEY) and AGENT_PRIVATE_KEY");
  process.exit(1);
}

const GAS_TARGET  = parseEther(process.env.FUND_GAS ?? "0.0003");
const USDC_TARGET = parseUnits(process.env.FUND_USDC ?? "0.5", 6);

async function main() {
  const sender = privateKeyToAccount(SENDER_PK!);
  const worker = privateKeyToAccount(WORKER_PK!).address;

  if (sender.address.toLowerCase() === worker.toLowerCase()) {
    console.error(`Refusing to run: sender and worker are the same wallet (${worker}). Nothing to fund.`);
    process.exit(1);
  }

  const rpc    = createPublicClient({ chain, transport: http(network.rpcUrl) });
  const wallet = createWalletClient({ account: sender, chain, transport: http(network.rpcUrl) });
  const usdc   = network.contracts.USDC as Address;
  const { symbol, isUsdc } = network.nativeCurrency;

  console.log(`network: ${networkName} (chain ${network.chainId})`);
  console.log(`from:    ${sender.address}`);
  console.log(`to:      ${worker}\n`);

  // Gas leg. On Arc the native token IS USDC, so a separate gas transfer would
  // just be a second USDC transfer - skip it there and let the USDC leg cover
  // both roles.
  if (isUsdc) {
    console.log(`gas:  skipped - native token on ${network.name} is USDC, the USDC leg below covers gas`);
  } else {
    const have = await rpc.getBalance({ address: worker });
    if (have >= GAS_TARGET) {
      console.log(`gas:  skipped - worker already holds ${formatEther(have)} ${symbol}`);
    } else {
      const send = GAS_TARGET - have;
      const hash = await wallet.sendTransaction({ to: worker, value: send });
      await rpc.waitForTransactionReceipt({ hash });
      console.log(`gas:  sent ${formatEther(send)} ${symbol}  ${hash}`);
    }
  }

  // Bond leg.
  const haveUsdc = await rpc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [worker] });
  if (haveUsdc >= USDC_TARGET) {
    console.log(`usdc: skipped - worker already holds ${formatUnits(haveUsdc, 6)} USDC`);
  } else {
    const send = USDC_TARGET - haveUsdc;
    const hash = await wallet.writeContract({ address: usdc, abi: erc20Abi, functionName: "transfer", args: [worker, send] });
    await rpc.waitForTransactionReceipt({ hash });
    console.log(`usdc: sent ${formatUnits(send, 6)} USDC  ${hash}`);
  }

  const [gasAfter, usdcAfter] = await Promise.all([
    rpc.getBalance({ address: worker }),
    rpc.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [worker] }),
  ]);
  console.log(`\nworker now holds: ${formatEther(gasAfter)} ${symbol} + ${formatUnits(usdcAfter, 6)} USDC`);
  console.log(`next: ARC_NETWORK=${networkName} ALLOW_MAINNET=yes npx tsx --env-file=../.env agent-proof-of-life.ts`);
}

main().catch(err => { console.error(err); process.exit(1); });
