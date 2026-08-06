import { isAddress, type Address } from "viem";

// ─── Networks ────────────────────────────────────────────────────────────────
//
// One build = one network. The active network is chosen at BUILD time by
// NEXT_PUBLIC_ARC_NETWORK (default "arc-testnet") — production ships as two
// separate Vercel projects, one per network, each with its own env vars.
// See frontend/README.md.
//
// This is the frontend's OWN copy of the network map — deliberately NOT the
// `arcbounty-agent-sdk` package (0.5.0, which has the equivalent
// `agent-sdk/src/constants.ts` map, is not published to npm yet; depending on
// it would break every Vercel build). A separate consistency-check script
// guards the two maps against drifting apart, so keep field names and
// per-network values mirrored with `agent-sdk/src/constants.ts` when editing
// either one.

export type NetworkName = "arc-testnet" | "arc-mainnet";

export type NetworkConfig = {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  explorerApiUrl: string;
  contracts: {
    AGENTIC_COMMERCE: Address;
    IDENTITY_REGISTRY: Address;
    REPUTATION_REGISTRY: Address;
    USDC: Address;
  };
  /**
   * Default BountyAdapter for this network. `NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS`
   * still overrides this exactly as it always has — see lib/contracts.ts.
   * Undefined on arc-testnet on purpose: that network has never had a baked-in
   * default, `NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS` has always been mandatory
   * there, and this keeps that behavior unchanged.
   */
  bountyAdapterAddress?: Address;
  /** Deployment block of the adapter — lower bound for chunked event scans. */
  adapterDeployBlock: bigint;
  /**
   * Whether the canonical Multicall3 deployment (see MULTICALL3_ADDRESS) is
   * live on this network. Verified true on Arc Testnet. Assumed true for Arc
   * mainnet too — Multicall3 ships from the same keyless deployer transaction
   * on nearly every EVM chain — revisit if that assumption doesn't hold once
   * Arc mainnet is live.
   */
  multicall3: boolean;
  testnet: boolean;
  /** Rough estimate (≈1s/block on Arc) for "last N days" style block math. */
  blocksPerDay: bigint;
  /** Fallback RPC log-scan bound — see lib/chainLogs.ts. */
  maxLookbackBlocks: bigint;
};

/** Canonical cross-chain Multicall3 address (see NetworkConfig.multicall3). */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Statically known networks. Arc MAINNET is deliberately absent here: Circle
 * has not published its parameters yet (chain id, RPC, contract addresses).
 * Use `getActiveNetwork()` / `resolveNetwork("arc-mainnet")`, which builds
 * the config from `NEXT_PUBLIC_ARC_MAINNET_*` environment variables and
 * throws a descriptive error while any of them are missing. Never hardcode
 * guessed mainnet values here.
 */
export const NETWORKS = {
  "arc-testnet": {
    chainId: 5_042_002,
    name: "Arc Testnet",
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.arc.network",
    explorerUrl: "https://testnet.arcscan.app",
    explorerApiUrl: "https://testnet.arcscan.app/api",
    contracts: {
      AGENTIC_COMMERCE:    "0x0747EEf0706327138c69792bF28Cd525089e4583",
      IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      USDC:                "0x3600000000000000000000000000000000000000",
    },
    adapterDeployBlock: 50_610_373n,
    multicall3: true,
    testnet: true,
    blocksPerDay: 86_400n,
    maxLookbackBlocks: 500_000n,
  },
} as const satisfies Record<"arc-testnet", NetworkConfig>;

const MAINNET_DOCS_URL = "https://docs.arc.io/arc/references/contract-addresses";

/** Required NEXT_PUBLIC_ARC_MAINNET_* env vars, in the order they are reported. */
const MAINNET_REQUIRED_VARS = [
  "NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID",
  "NEXT_PUBLIC_ARC_MAINNET_RPC_URL",
  "NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL",
  "NEXT_PUBLIC_ARC_MAINNET_EXPLORER_API_URL",
  "NEXT_PUBLIC_ARC_MAINNET_AGENTIC_COMMERCE",
  "NEXT_PUBLIC_ARC_MAINNET_IDENTITY_REGISTRY",
  "NEXT_PUBLIC_ARC_MAINNET_REPUTATION_REGISTRY",
  "NEXT_PUBLIC_ARC_MAINNET_USDC",
  "NEXT_PUBLIC_ARC_MAINNET_BOUNTY_ADAPTER",
  "NEXT_PUBLIC_ARC_MAINNET_ADAPTER_DEPLOY_BLOCK",
  "NEXT_PUBLIC_ARC_MAINNET_BLOCKS_PER_DAY",
  "NEXT_PUBLIC_ARC_MAINNET_MAX_LOOKBACK_BLOCKS",
] as const;

function readEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function requireAddress(vars: [name: string, value: string][]): void {
  const invalid = vars.filter(([, value]) => !isAddress(value));
  if (invalid.length > 0) {
    throw new Error(
      `[arcbounty] resolveNetwork("arc-mainnet"): invalid address in environment variable(s): ` +
      invalid.map(([name, value]) => `${name}="${value}"`).join(", ") +
      `. Expected 0x-prefixed 20-byte addresses as published at ${MAINNET_DOCS_URL}.`,
    );
  }
}

function parseIntStrict(name: string, value: string, min = 0): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`[arcbounty] resolveNetwork("arc-mainnet"): ${name}="${value}" is not an integer >= ${min}.`);
  }
  return parsed;
}

function parseBigIntStrict(name: string, value: string, min = 0n): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`[arcbounty] resolveNetwork("arc-mainnet"): ${name}="${value}" is not an integer.`);
  }
  if (parsed < min) {
    throw new Error(`[arcbounty] resolveNetwork("arc-mainnet"): ${name}="${value}" is not an integer >= ${min}.`);
  }
  return parsed;
}

/**
 * Resolve a network name into a concrete {@link NetworkConfig}.
 *
 * - `"arc-testnet"` → the static {@link NETWORKS} entry.
 * - `"arc-mainnet"` → built entirely from `NEXT_PUBLIC_ARC_MAINNET_*`
 *   environment variables. Circle has not published Arc mainnet parameters
 *   yet; until every required variable is set this throws a single error
 *   listing all missing ones. Source of truth once published:
 *   ${MAINNET_DOCS_URL}.
 */
export function resolveNetwork(name: NetworkName): NetworkConfig {
  if (name === "arc-testnet") {
    return NETWORKS["arc-testnet"];
  }

  const missing = MAINNET_REQUIRED_VARS.filter(key => readEnv(key) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `[arcbounty] resolveNetwork("arc-mainnet"): Arc mainnet is not configured — missing environment ` +
      `variable(s): ${missing.join(", ")}. Circle publishes the official chain parameters and contract ` +
      `addresses at ${MAINNET_DOCS_URL} (source of truth) — never guess them. Set the variables once ` +
      `published, or build with NEXT_PUBLIC_ARC_NETWORK=arc-testnet until then.`,
    );
  }

  const chainId              = parseIntStrict("NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID", readEnv("NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID")!, 1);
  const agenticCommerce       = readEnv("NEXT_PUBLIC_ARC_MAINNET_AGENTIC_COMMERCE")!;
  const identityRegistry      = readEnv("NEXT_PUBLIC_ARC_MAINNET_IDENTITY_REGISTRY")!;
  const reputationRegistry    = readEnv("NEXT_PUBLIC_ARC_MAINNET_REPUTATION_REGISTRY")!;
  const usdc                  = readEnv("NEXT_PUBLIC_ARC_MAINNET_USDC")!;
  const bountyAdapter         = readEnv("NEXT_PUBLIC_ARC_MAINNET_BOUNTY_ADAPTER")!;

  requireAddress([
    ["NEXT_PUBLIC_ARC_MAINNET_AGENTIC_COMMERCE",    agenticCommerce],
    ["NEXT_PUBLIC_ARC_MAINNET_IDENTITY_REGISTRY",   identityRegistry],
    ["NEXT_PUBLIC_ARC_MAINNET_REPUTATION_REGISTRY", reputationRegistry],
    ["NEXT_PUBLIC_ARC_MAINNET_USDC",                usdc],
    ["NEXT_PUBLIC_ARC_MAINNET_BOUNTY_ADAPTER",      bountyAdapter],
  ]);

  return {
    chainId,
    name: "Arc",
    rpcUrl:         readEnv("NEXT_PUBLIC_ARC_MAINNET_RPC_URL")!,
    explorerUrl:    readEnv("NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL")!,
    explorerApiUrl: readEnv("NEXT_PUBLIC_ARC_MAINNET_EXPLORER_API_URL")!,
    contracts: {
      AGENTIC_COMMERCE:    agenticCommerce as Address,
      IDENTITY_REGISTRY:   identityRegistry as Address,
      REPUTATION_REGISTRY: reputationRegistry as Address,
      USDC:                usdc as Address,
    },
    bountyAdapterAddress: bountyAdapter as Address,
    adapterDeployBlock: parseBigIntStrict("NEXT_PUBLIC_ARC_MAINNET_ADAPTER_DEPLOY_BLOCK", readEnv("NEXT_PUBLIC_ARC_MAINNET_ADAPTER_DEPLOY_BLOCK")!),
    // Assumed true — see NetworkConfig.multicall3 doc comment.
    multicall3: true,
    testnet: false,
    blocksPerDay: parseBigIntStrict("NEXT_PUBLIC_ARC_MAINNET_BLOCKS_PER_DAY", readEnv("NEXT_PUBLIC_ARC_MAINNET_BLOCKS_PER_DAY")!, 1n),
    maxLookbackBlocks: parseBigIntStrict("NEXT_PUBLIC_ARC_MAINNET_MAX_LOOKBACK_BLOCKS", readEnv("NEXT_PUBLIC_ARC_MAINNET_MAX_LOOKBACK_BLOCKS")!, 1n),
  };
}

/** Which network this build targets — `NEXT_PUBLIC_ARC_NETWORK`, default `"arc-testnet"`. */
export function getActiveNetworkName(): NetworkName {
  const raw = process.env.NEXT_PUBLIC_ARC_NETWORK;
  if (!raw || raw === "arc-testnet") return "arc-testnet";
  if (raw === "arc-mainnet") return "arc-mainnet";
  throw new Error(
    `[arcbounty] NEXT_PUBLIC_ARC_NETWORK="${raw}" is not a valid network — expected "arc-testnet" or "arc-mainnet".`,
  );
}

/** Resolved config for the active build's network — see {@link getActiveNetworkName}. */
export function getActiveNetwork(): NetworkConfig {
  return resolveNetwork(getActiveNetworkName());
}
