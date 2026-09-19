/**
 * Move the deployer's USDC from Base to Arc mainnet through Relay, then give
 * the keeper and the agent wallet 1 USDC each of gas on Arc.
 *
 * Gasless on Base: the deployer holds USDC there but no ETH, so the bridge runs
 * on a single EIP-3009 ReceiveWithAuthorization signature. Only the `to` of
 * that authorization can redeem it, and only into itself - so before signing,
 * this checks that `to` is Relay's approvalProxy as listed in Relay's own chain
 * registry and has code on Base, that the amount and `from` are exactly ours,
 * and that no step asks for an on-chain Base transaction. Relay's solver pays
 * the Base gas and delivers native USDC on Arc, where receiving needs no gas.
 *
 * Moves real funds, so it is run by hand and asks before signing. In cmd:
 *   cd /d C:\Server\ARC\scripts
 *   npx tsx bridge-base-to-arc.ts
 * `--quote-only` runs every check against a live quote and stops before signing.
 * `--no-top-ups` bridges only: the launch-day gas for the keeper and the agent
 * is skipped (the agent's was pooled into the deployer on 2026-09-18).
 *
 * Reads PRIVATE_KEY (the deployer) from the root .env, plus KEEPER_PRIVATE_KEY
 * and AGENT_PRIVATE_KEY only to derive the two top-up addresses.
 */
// First, before anything touches the network: a dead router DNS must not stop this.
import "./lib/dns-fallback.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient, createWalletClient, http, parseEther, formatEther, formatUnits, getAddress,
  type Address, type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { resolveNetwork } from "../agent-sdk/src/constants.js";
import { buildChain } from "./lib/network.js";

const RELAY = "https://api.relay.link";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000";
// Arc's native USDC has 18 decimals (its ERC-20 view has 6).
const GAS_TOP_UP = parseEther("1");
const QUOTE_ONLY = process.argv.includes("--quote-only");
const NO_TOP_UPS = process.argv.includes("--no-top-ups");

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

const fileEnv = readDotEnv(join(ROOT, ".env"));
const need = (name: string): string => {
  const value = process.env[name]?.trim() || fileEnv[name];
  if (!value) throw new Error(`Missing ${name} in the root .env`);
  return value;
};

const usdc6 = (v: bigint) => formatUnits(v, 6);
const usdc18 = (v: bigint) => formatEther(v);

async function relay<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${RELAY}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Relay ${init?.method ?? "GET"} ${path.split("?")[0]} -> ${res.status}: ${text.slice(0, 300)}`);
  // An accepted permit may come back with an empty body - that is not a failure.
  return (text ? JSON.parse(text) : {}) as T;
}

/** The typed-data message with its integer fields as bigints, the form viem signs. */
function permitMessage(value: SignData["value"]) {
  return {
    ...value,
    value: BigInt(value.value),
    validAfter: BigInt(value.validAfter),
    validBefore: BigInt(value.validBefore),
  };
}

type SignData = {
  signatureKind: string;
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  value: { from: Address; to: Address; value: string; validAfter: number; validBefore: number; nonce: Hex };
};
type Step = {
  id: string;
  kind: string;
  items: { status: string; data?: { sign?: SignData; post?: { endpoint: string; method: string; body: unknown } }; check?: { endpoint: string } }[];
};
type Quote = {
  steps: Step[];
  details: {
    recipient?: string;
    currencyIn: { amount: string; currency: { chainId: number; address: string } };
    currencyOut: { amount: string; amountFormatted: string; currency: { chainId: number; address: string } };
    timeEstimate?: number;
  };
  fees?: Record<string, { amountUsd?: string }>;
};

async function main() {
  const deployer = privateKeyToAccount(need("PRIVATE_KEY") as Hex);
  const keeper = privateKeyToAccount(need("KEEPER_PRIVATE_KEY") as Hex).address;
  const agent = privateKeyToAccount(need("AGENT_PRIVATE_KEY") as Hex).address;

  const arc = resolveNetwork("arc-mainnet");
  const arcChain = buildChain(arc);
  const basePub = createPublicClient({ chain: base, transport: http(process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org") });
  const arcPub = createPublicClient({ chain: arcChain, transport: http(arc.rpcUrl) });
  const arcWallet = createWalletClient({ account: deployer, chain: arcChain, transport: http(arc.rpcUrl) });

  if ((await basePub.getChainId()) !== base.id) throw new Error("ABORT: the Base RPC is not chain 8453");
  if ((await arcPub.getChainId()) !== arc.chainId) throw new Error(`ABORT: the Arc RPC is not chain ${arc.chainId}`);

  const amount = await basePub.readContract({
    address: BASE_USDC,
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const,
    functionName: "balanceOf",
    args: [deployer.address],
  });
  const arcBefore = await arcPub.getBalance({ address: deployer.address });

  console.log(`deployer: ${deployer.address}`);
  console.log(`  Base USDC: ${usdc6(amount)}   Arc USDC: ${usdc18(arcBefore)}`);
  console.log(`keeper:   ${keeper}   Arc USDC: ${usdc18(await arcPub.getBalance({ address: keeper }))}`);
  console.log(`agent:    ${agent}   Arc USDC: ${usdc18(await arcPub.getBalance({ address: agent }))}`);

  let quote: Quote | null = null;
  let sign: SignData | null = null;
  let post: { endpoint: string; method: string; body: unknown } | null = null;
  let check: { endpoint: string } | null = null;

  if (amount > 0n) {
    quote = await relay<Quote>("/quote", {
      method: "POST",
      body: JSON.stringify({
        user: deployer.address,
        recipient: deployer.address,
        originChainId: base.id,
        destinationChainId: arc.chainId,
        originCurrency: BASE_USDC,
        destinationCurrency: NATIVE,
        amount: amount.toString(),
        tradeType: "EXACT_INPUT",
        usePermit: true,
      }),
    });

    // Every check below must pass before anything is signed.
    const nonSignature = quote.steps.filter(s => s.kind !== "signature");
    if (nonSignature.length > 0) {
      throw new Error(`ABORT: Relay asked for on-chain step(s) ${nonSignature.map(s => s.id).join(", ")}, which need ETH on Base. Nothing signed.`);
    }
    if (quote.steps.length !== 1 || quote.steps[0]!.items.length !== 1) {
      throw new Error("ABORT: expected exactly one signature from Relay. Nothing signed.");
    }
    const item = quote.steps[0]!.items[0]!;
    sign = item.data?.sign ?? null;
    post = item.data?.post ?? null;
    check = item.check ?? null;
    if (!sign || !post || !check) throw new Error("ABORT: Relay's signature step is incomplete. Nothing signed.");

    const chains = await relay<{ chains: { id: number; contracts?: { approvalProxy?: string } }[] }>("/chains");
    const approvalProxy = chains.chains.find(c => c.id === base.id)?.contracts?.approvalProxy;
    const to = getAddress(sign.value.to);
    const problems = [
      sign.signatureKind !== "eip712" && "signature kind is not EIP-712",
      sign.primaryType !== "ReceiveWithAuthorization" && `primaryType is ${sign.primaryType}`,
      sign.domain.chainId !== base.id && "the authorization is not for Base",
      getAddress(sign.domain.verifyingContract) !== getAddress(BASE_USDC) && "the token is not Base USDC",
      getAddress(sign.value.from) !== deployer.address && "`from` is not the deployer",
      BigInt(sign.value.value) !== amount && "the amount differs from the balance being bridged",
      (!approvalProxy || getAddress(approvalProxy) !== to) && "`to` is not Relay's approvalProxy on Base",
      quote.details.currencyOut.currency.chainId !== arc.chainId && "the destination is not Arc mainnet",
      quote.details.currencyOut.currency.address !== NATIVE && "the payout is not native USDC",
      (!quote.details.recipient || getAddress(quote.details.recipient) !== deployer.address) && "the recipient on Arc is not the deployer",
      // Base USDC has 6 decimals, the Arc payout 18.
      BigInt(quote.details.currencyOut.amount) < amount * 10n ** 12n * 97n / 100n && "more than 3% would be lost to fees",
    ].filter(Boolean);
    const code = await basePub.getCode({ address: to });
    if (!code || code === "0x") problems.push("`to` has no code on Base");
    if (problems.length > 0) throw new Error(`ABORT: ${problems.join("; ")}. Nothing signed.`);

    const fees = Object.entries(quote.fees ?? {})
      .filter(([, f]) => f.amountUsd && Number(f.amountUsd) > 0)
      .map(([k, f]) => `${k} $${Number(f.amountUsd).toFixed(4)}`).join(", ");
    console.log(`\nbridge:   ${usdc6(amount)} USDC on Base -> ${quote.details.currencyOut.amountFormatted} USDC on Arc`);
    console.log(`          to ${deployer.address}, about ${quote.details.timeEstimate ?? "?"}s, fees: ${fees || "none"}`);
    console.log(`          one signature, redeemable only by Relay's approvalProxy ${to} (checked)`);
  } else {
    console.log("\nnothing left on Base to bridge.");
  }

  const topUps = NO_TOP_UPS ? [] : [keeper, agent];
  console.log(NO_TOP_UPS
    ? "then:     no gas top-ups (--no-top-ups)"
    : "then:     1 USDC of gas on Arc to the keeper and to the agent, where they hold less than 1");

  if (QUOTE_ONLY) {
    console.log("\n--quote-only: all checks passed, nothing signed or sent.");
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("\nType yes to sign and send (the signature is valid for about 10 minutes): ")).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") {
    console.log("Stopped. Nothing signed or sent.");
    return;
  }

  if (quote && sign && post && check) {
    const signature = await deployer.signTypedData({
      domain: sign.domain,
      types: sign.types,
      primaryType: sign.primaryType,
      message: permitMessage(sign.value),
    });
    await relay(`${post.endpoint}?signature=${signature}`, { method: post.method, body: JSON.stringify(post.body) });
    console.log("signed and handed to Relay, waiting for delivery...");

    const deadline = Date.now() + 5 * 60_000;
    let status = "waiting";
    while (Date.now() < deadline) {
      const s = await relay<{ status: string; txHashes?: string[] }>(check.endpoint);
      if (s.status !== status) console.log(`  relay status: ${s.status}${s.txHashes?.length ? `  txs: ${s.txHashes.join(", ")}` : ""}`);
      status = s.status;
      if (["success", "failure", "refund", "refunded"].includes(status)) break;
      await new Promise(r => setTimeout(r, 2_000));
    }
    if (status !== "success") throw new Error(`Relay finished with status "${status}" - check the request on relay.link before retrying.`);

    let arcNow = arcBefore;
    for (let i = 0; i < 30 && arcNow <= arcBefore; i++) {
      await new Promise(r => setTimeout(r, 2_000));
      arcNow = await arcPub.getBalance({ address: deployer.address });
    }
    console.log(`deployer Arc USDC: ${usdc18(arcBefore)} -> ${usdc18(arcNow)}`);
  }

  for (const to of topUps) {
    const have = await arcPub.getBalance({ address: to });
    if (have >= GAS_TOP_UP) {
      console.log(`skip ${to}: already holds ${usdc18(have)} USDC`);
      continue;
    }
    const hash = await arcWallet.sendTransaction({ to, value: GAS_TOP_UP });
    const receipt = await arcPub.waitForTransactionReceipt({ hash });
    console.log(`sent 1 USDC to ${to}: ${hash} (${receipt.status})`);
  }

  console.log("\nArc mainnet balances now:");
  for (const [label, address] of [["deployer", deployer.address], ["keeper", keeper], ["agent", agent]] as const) {
    console.log(`  ${label.padEnd(8)} ${address}  ${usdc18(await arcPub.getBalance({ address }))} USDC`);
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
