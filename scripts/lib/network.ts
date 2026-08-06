/**
 * Shared chain/network helper for the ops scripts (seed*, reclaim-bounties,
 * safe-add-signer, agent-proof-of-life, bounty-timeline, ...).
 *
 * Imports `resolveNetwork` straight from `agent-sdk/src` (not the
 * `arcbounty-agent-sdk` npm package) — these scripts already run via `tsx`
 * from the repo root, agent-sdk and scripts are siblings in this monorepo,
 * and `constants.ts` has zero relative imports of its own, so this stays a
 * single self-contained hop with no build/publish step in between.
 *
 * Env:
 *   ARC_NETWORK           — "arc-testnet" (default) | "arc-mainnet"
 *   ARC_TESTNET_RPC_URL   — testnet-only RPC override (the ops scripts'
 *                           long-standing var name — kept for back-compat
 *                           with existing `.env` files; resolveNetwork's own
 *                           ARC_RPC_URL still applies underneath it)
 *   ALLOW_MAINNET=yes     — required opt-in for money-moving scripts before
 *                           they'll touch arc-mainnet (see assertMoneyMoveAllowed)
 *   ARC_MAINNET_*         — required by resolveNetwork() once ARC_NETWORK is
 *                           "arc-mainnet"; see agent-sdk/.env.example
 */

import { defineChain, type Chain } from "viem";
import { resolveNetwork, type NetworkName, type NetworkConfig } from "../../agent-sdk/src/constants.js";

export type { NetworkName, NetworkConfig };
export { resolveNetwork };

type Env = Record<string, string | undefined>;

/** Which network the ops scripts target — ARC_NETWORK, default "arc-testnet". */
export function getNetworkName(env: Env = process.env): NetworkName {
  const raw = env["ARC_NETWORK"]?.trim();
  if (!raw || raw === "arc-testnet") return "arc-testnet";
  if (raw === "arc-mainnet") return "arc-mainnet";
  throw new Error(
    `ARC_NETWORK="${raw}" is not a valid network — expected "arc-testnet" or "arc-mainnet".`,
  );
}

/**
 * Resolved network config for ARC_NETWORK, via the agent-sdk's own
 * resolveNetwork() — same chain id / contracts / canonical adapter the SDK,
 * MCP server, and facade-api all resolve to. Throws a descriptive error
 * (listing exactly which ARC_MAINNET_* vars are missing) if ARC_NETWORK is
 * "arc-mainnet" and mainnet isn't fully configured yet.
 *
 * On testnet, ARC_TESTNET_RPC_URL (if set) overrides the RPC beyond what
 * resolveNetwork's own ARC_RPC_URL handling already does — preserves the ops
 * scripts' pre-existing env var so nothing already configured breaks.
 */
export function getNetwork(env: Env = process.env): NetworkConfig {
  const name = getNetworkName(env);
  const network = resolveNetwork(name, env);
  const testnetRpcOverride = name === "arc-testnet" ? env["ARC_TESTNET_RPC_URL"]?.trim() : undefined;
  return testnetRpcOverride ? { ...network, rpcUrl: testnetRpcOverride } : network;
}

/**
 * Build a viem `Chain` for a resolved network. Native gas on Arc is USDC
 * (Circle L1) — matches the chain object every other package in this repo
 * defines (agent-sdk's ArcBountyAgent, frontend's wagmi config).
 */
export function buildChain(network: NetworkConfig): Chain {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [network.rpcUrl] }, public: { http: [network.rpcUrl] } },
  });
}

/**
 * Money-moving scripts (seed-bounties, seed-extra, reseed-2,
 * post-single-bounty, reclaim-bounties, safe-add-signer,
 * agent-proof-of-life) MUST call this — right after resolving the network,
 * before touching any wallet/tx logic. Refuses to run against arc-mainnet
 * (real USDC) unless the operator explicitly opts in with ALLOW_MAINNET=yes.
 */
export function assertMoneyMoveAllowed(network: NetworkConfig, env: Env = process.env): void {
  if (network.testnet) return;
  if (env["ALLOW_MAINNET"] === "yes") return;
  throw new Error(
    `Refusing to run on "${network.name}" — this script moves real USDC. ` +
    `Set ALLOW_MAINNET=yes once you have verified the recipients/amounts and really mean it.`,
  );
}

/**
 * Resolve the network and enforce the mainnet opt-in in one call, with a
 * clean console.error + exit(1) instead of an unhandled-exception stack
 * trace — the two failure modes (bad ARC_NETWORK / unconfigured mainnet /
 * mainnet without ALLOW_MAINNET) all end up here for money-moving scripts.
 */
export function requireNetworkForMoneyMove(env: Env = process.env): NetworkConfig {
  try {
    const network = getNetwork(env);
    assertMoneyMoveAllowed(network, env);
    return network;
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

/**
 * Resolve the network for read-only scripts (bounty-timeline, ...) — same
 * clean-error treatment, without the mainnet money-move guard.
 */
export function requireNetwork(env: Env = process.env): NetworkConfig {
  try {
    return getNetwork(env);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
