#!/usr/bin/env node
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ArcBountyAgent, resolveNetwork, type NetworkName } from "arcbounty-agent-sdk";
import { createMcpServer } from "./tools.js";
import { readSpendLimits, type SpendLimits } from "./limits.js";

// Read name and version off package.json instead of repeating them here:
// registries label their listings with whatever the server reports at
// `initialize`, so a stale literal shows up publicly as a version that doesn't
// exist on npm - Glama's first release went out as 0.1.0 while npm was already
// on 0.1.1. The name doubles as the stderr tag, so a differently-named
// distribution of this same server labels its own logs correctly.
const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string };
const TAG = `[${pkg.name}]`;

// ─── Agent instance ────────────────────────────────────────────────────────
//
// Read-only tools always work (no signer needed - listOpenBounties/getBounty
// are public view calls). Write tools (take/submit/register/...) only
// register if a signer is configured, via the same env-var conventions the
// SDK itself and its examples already use:
//
//   ARC_NETWORK               - which chain this instance serves: "arc-testnet"
//                               (default), "arc-mainnet", "base-sepolia" or
//                               "base-mainnet". The Base entries are the same
//                               product under its own name, BaseBounty
//                               (basebounty.app) - one package, one instance
//                               per chain, brand read from the network.
//                               All four are configured inside the SDK;
//                               arc-mainnet and base-mainnet move real USDC.
//   AGENT_PRIVATE_KEY        - raw EOA private key, OR:
//   CIRCLE_API_KEY / ENTITY_SECRET / CIRCLE_WALLET_ID / CIRCLE_WALLET_ADDRESS
//                             - Circle developer-controlled wallet (no key
//                               in this process at all - see
//                               agent-sdk/docs/circle-wallet.md)
//   BOUNTY_ADAPTER_ADDRESS    - optional override, testnets only. Every network
//                               ships its canonical adapter inside the SDK, so
//                               an unconfigured server is a working read-only
//                               one. The SDK ignores this variable on mainnet
//                               chains on purpose, so that a stale testnet
//                               address can never leak onto mainnet - which is
//                               why this file hands the decision to the SDK
//                               rather than reading the variable itself.
//                               Source of truth: contracts/DEPLOYMENTS.md.
//   ARC_RPC_URL (optional)    - overrides the RPC endpoint for whichever
//                               network ARC_NETWORK resolves to (unchanged
//                               from pre-network-selection behavior - this is
//                               a transport-only override, so on arc-mainnet
//                               it still talks to the mainnet chain id, just
//                               through this URL instead of ARC_MAINNET_RPC_URL).
//                               The SDK's own BASE_MAINNET_RPC_URL /
//                               BASE_SEPOLIA_RPC_URL do the same for the Base
//                               entries; ARC_RPC_URL wins over both. Because
//                               it applies to any network, the server checks
//                               the node's eth_chainId at startup and refuses
//                               to run against a node on another chain.
//   ARCBOUNTY_MAX_REWARD_USDC / ARCBOUNTY_MAX_SPEND_USDC (optional)
//                             - caps on post_bounty: the largest single reward
//                               and the total posted per run of this server
//                               (defaults 20 and 50 USDC, see limits.ts). Set
//                               by the operator; no tool can raise them.

const KNOWN_NETWORKS = [
  "arc-testnet",
  "arc-mainnet",
  "base-sepolia",
  "base-mainnet",
] as const satisfies readonly NetworkName[];

// Compile-time drift guard. This list said "arc-testnet, arc-mainnet" for the
// two weeks BaseBounty was live on Base mainnet: ARC_NETWORK=base-mainnet was
// refused at startup by a server whose SDK supported it perfectly well, and
// nothing failed loudly enough to notice. A NetworkName the list doesn't cover
// now breaks the build here - the error names the missing network - instead of
// breaking at someone else's runtime.
type UnlistedNetwork = Exclude<NetworkName, (typeof KNOWN_NETWORKS)[number]>;
const _networksExhaustive: [UnlistedNetwork] extends [never] ? true : UnlistedNetwork = true;
void _networksExhaustive;

/** Returns `null` (after logging) on an unrecognized ARC_NETWORK value, mirroring
 * the other startup-validation failures in this function. */
function readNetwork(): NetworkName | null {
  const raw = process.env["ARC_NETWORK"];
  if (!raw) return "arc-testnet";
  if ((KNOWN_NETWORKS as readonly string[]).includes(raw)) return raw as NetworkName;
  console.error(
    `${TAG} Invalid ARC_NETWORK="${raw}" - expected one of: ${KNOWN_NETWORKS.join(", ")}. ` +
    "Server will not start.",
  );
  return null;
}

function buildAgent(): ArcBountyAgent | null {
  const network = readNetwork();
  if (!network) return null;

  // Deliberately not read here: BOUNTY_ADAPTER_ADDRESS. Passing it as an
  // explicit constructor argument would override the SDK's own precedence
  // (explicit > env-on-testnet > the network's canonical adapter) and defeat
  // its guard against a testnet address leaking onto a mainnet chain. Leaving
  // it to the SDK also means every network now has a default, so the server
  // starts read-only with no configuration at all.
  const rpcUrl = process.env["ARC_RPC_URL"];

  const circleApiKey = process.env["CIRCLE_API_KEY"];
  const entitySecret = process.env["ENTITY_SECRET"];
  const circleWalletId = process.env["CIRCLE_WALLET_ID"];
  const circleWalletAddress = process.env["CIRCLE_WALLET_ADDRESS"] as `0x${string}` | undefined;
  const privateKey = process.env["AGENT_PRIVATE_KEY"] as `0x${string}` | undefined;

  if (circleApiKey && entitySecret && circleWalletId && circleWalletAddress) {
    // Both configured is a misconfiguration - the two are alternatives - and
    // the quiet version of it costs hours. A Circle wallet found in the ambient
    // environment silently outranked an AGENT_PRIVATE_KEY set deliberately for
    // this run, so every write was signed by a different address than the
    // operator believed: accepted by Circle, handed back a transaction hash,
    // and never mined, because that wallet held no gas on the target chain.
    if (privateKey) {
      console.error(
        `${TAG} Both a Circle wallet and AGENT_PRIVATE_KEY are configured. These are alternatives, not ` +
        `layers: the Circle wallet wins, so this server signs as ${circleWalletAddress}. Unset the ` +
        "CIRCLE_* variables to use AGENT_PRIVATE_KEY instead.",
      );
    }
    return new ArcBountyAgent({
      network,
      circleWallet: {
        apiKey: circleApiKey,
        entitySecret,
        walletId: circleWalletId,
        address: circleWalletAddress,
        // V4.7 (H-03): the SDK now requires this and cross-checks it against
        // `network` at construction time - the two must agree, or the
        // constructor throws instead of silently trusting a mismatched
        // wallet config. Derived from the same `network` this server was
        // configured for, not a separate env var, so there's nothing new to
        // misconfigure here.
        chainId: resolveNetwork(network).chainId,
      },
      rpcUrl,
    });
  }
  if (privateKey) {
    return new ArcBountyAgent({ network, privateKey, rpcUrl });
  }

  // No signer configured - read-only mode. Still useful: browsing bounties
  // needs no credentials at all.
  console.error(
    `${TAG} No signer configured (AGENT_PRIVATE_KEY or CIRCLE_API_KEY+ENTITY_SECRET+` +
    "CIRCLE_WALLET_ID+CIRCLE_WALLET_ADDRESS) - starting in READ-ONLY mode. " +
    "take_bounty/submit_work/register_agent/etc. will not be registered.",
  );
  // ArcBountyAgent's constructor requires a signer; view-only calls (listOpenBounties,
  // getBounty, getReputation) don't actually need one, so we use a throwaway
  // burner key purely to satisfy the constructor - it is never used to sign
  // anything because no write tools are registered in this mode.
  const burner = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
  return new ArcBountyAgent({ network, privateKey: burner, rpcUrl });
}

let agent: ArcBountyAgent | null;
try {
  agent = buildAgent();
} catch (err) {
  // Thrown by the SDK constructor itself, e.g. a Circle wallet configured for
  // another chain. The SDK's error message already says what is wrong.
  console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
  agent = null;
}
if (!agent) process.exit(1);

/** Mirrors the precedence in buildAgent: the Circle wallet is chosen first. */
const usingCircleWallet = Boolean(
  process.env["CIRCLE_API_KEY"] && process.env["ENTITY_SECRET"] &&
  process.env["CIRCLE_WALLET_ID"] && process.env["CIRCLE_WALLET_ADDRESS"],
);

const hasSigner = Boolean(process.env["AGENT_PRIVATE_KEY"] || usingCircleWallet);

// ─── Server ─────────────────────────────────────────────────────────────────
//
// Tools, wording and branding live in tools.ts so the hosted HTTP transport
// serves exactly what this one does. Everything above is the part that only
// makes sense for a local process: environment variables and a signer.

let limits: SpendLimits;
try {
  limits = readSpendLimits(process.env);
} catch (err) {
  console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}. Server will not start.`);
  process.exit(1);
}

const net = agent.network;
const BRAND = net.brand.name;
const server = createMcpServer({ agent, hasSigner, version: pkg.version, limits });

/**
 * ARC_RPC_URL overrides the RPC for whatever ARC_NETWORK selects, and
 * .env.example long shipped it set to the Arc testnet node. With
 * ARC_NETWORK=arc-mainnet that pairing reads the testnet chain under the
 * mainnet adapter's address - an empty board - and every signed write fails on
 * the chain id. Ask the node which chain it is before serving anything. A node
 * that does not answer is only a warning: the SDK retries, and the read tools
 * surface a real error on first use.
 */
async function checkRpcChain(): Promise<void> {
  const url = process.env["ARC_RPC_URL"]?.trim();
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: string };
    const chainId = body.result ? Number(BigInt(body.result)) : NaN;
    if (Number.isNaN(chainId)) {
      console.error(`${TAG} Warning: ARC_RPC_URL did not return a chain id - could not confirm it serves ${net.name}.`);
      return;
    }
    if (chainId !== net.chainId) {
      console.error(
        `${TAG} ARC_RPC_URL points at chain ${chainId}, but ARC_NETWORK=${process.env["ARC_NETWORK"] ?? "arc-testnet"} ` +
        `is ${net.name} (chain ${net.chainId}). Fix or unset ARC_RPC_URL - each network already has a default RPC. ` +
        "Server will not start.",
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(
      `${TAG} Warning: could not reach ARC_RPC_URL to confirm its chain (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

async function main() {
  await checkRpcChain();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // console.error, never console.log - stdout is the JSON-RPC transport
  // itself, and anything printed there corrupts the stream from the host's
  // perspective.
  // Name the chain, and name the wallet. An instance pointed at the wrong
  // network is otherwise indistinguishable from a working one until its first
  // empty board - and an instance signing as the wrong address is worse, since
  // it looks entirely healthy right up to the transaction that never mines.
  // This one line is the difference between five seconds of diagnosis and a
  // day of it.
  const signer = hasSigner
    ? ` - signing as ${agent!.address}${usingCircleWallet ? " (Circle wallet)" : ""}`
    : " - read-only mode, no signer configured";
  console.error(`${TAG} ${BRAND} running on stdio - ${net.name} (chain ${net.chainId})${signer}`);
}

main().catch(err => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
