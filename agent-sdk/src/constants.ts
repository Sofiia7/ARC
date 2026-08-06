import { isAddress, type Address } from "viem";

// ─── Networks ────────────────────────────────────────────────────────────────

export type NetworkName = "arc-testnet" | "arc-mainnet";

export type NetworkConfig = {
  chainId: number;
  name: string;
  /** CAIP-2 identifier (`eip155:<chainId>`), e.g. for x402 network fields. */
  caip2: string;
  rpcUrl: string;
  explorerUrl: string;
  explorerApiUrl: string;
  contracts: {
    AGENTIC_COMMERCE: Address;
    IDENTITY_REGISTRY: Address;
    REPUTATION_REGISTRY: Address;
    USDC: Address;
  };
  /** Canonical BountyAdapter for this network (see contracts/DEPLOYMENTS.md).
   * Explicit `bountyAdapterAddress` / `BOUNTY_ADAPTER_ADDRESS` still win. */
  defaultBountyAdapter?: Address;
  /** Block the canonical adapter was deployed at — lower bound for log scans. */
  adapterDeployBlock?: number;
  testnet: boolean;
  /** Rough estimate (≈1s/block on Arc) for "last N days" style block math. */
  blocksPerDay: number;
};

/**
 * Statically known networks. Arc MAINNET is deliberately absent: Circle has
 * not published its parameters yet (chain id, RPC, contract addresses —
 * source of truth: https://docs.arc.io/arc/references/contract-addresses).
 * Use `resolveNetwork("arc-mainnet")`, which builds the config from
 * `ARC_MAINNET_*` environment variables and fails with a descriptive error
 * while they are missing. Never hardcode guessed mainnet values here.
 */
export const NETWORKS = {
  "arc-testnet": {
    chainId: 5_042_002,
    name: "Arc Testnet",
    caip2: "eip155:5042002",
    rpcUrl: "https://rpc.testnet.arc.network",
    explorerUrl: "https://testnet.arcscan.app",
    explorerApiUrl: "https://testnet.arcscan.app/api",
    contracts: {
      AGENTIC_COMMERCE:    "0x0747EEf0706327138c69792bF28Cd525089e4583",
      IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      USDC:                "0x3600000000000000000000000000000000000000",
    },
    defaultBountyAdapter: "0x538CD48789667168bfb36f838Af8476237F9409F",
    adapterDeployBlock: 50_610_373,
    testnet: true,
    blocksPerDay: 86_400,
  },
} as const satisfies Record<string, NetworkConfig>;

const MAINNET_DOCS_URL = "https://docs.arc.io/arc/references/contract-addresses";

/** Required env vars for arc-mainnet, in the order they are reported. */
const MAINNET_REQUIRED_VARS = [
  "ARC_MAINNET_CHAIN_ID",
  "ARC_MAINNET_RPC_URL",
  "ARC_MAINNET_EXPLORER_URL",
  "ARC_MAINNET_EXPLORER_API_URL",
  "ARC_MAINNET_AGENTIC_COMMERCE",
  "ARC_MAINNET_IDENTITY_REGISTRY",
  "ARC_MAINNET_REPUTATION_REGISTRY",
  "ARC_MAINNET_USDC",
] as const;

type Env = Record<string, string | undefined>;

function readEnv(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function requireAddress(vars: [name: string, value: string][]): void {
  const invalid = vars.filter(([, value]) => !isAddress(value));
  if (invalid.length > 0) {
    throw new Error(
      `resolveNetwork("arc-mainnet"): invalid address in environment variable(s): ` +
      invalid.map(([name, value]) => `${name}="${value}"`).join(", ") +
      `. Expected 0x-prefixed 20-byte addresses as published at ${MAINNET_DOCS_URL}.`,
    );
  }
}

function parseIntStrict(name: string, value: string, min = 1): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(
      `resolveNetwork("arc-mainnet"): ${name}="${value}" is not an integer >= ${min}.`,
    );
  }
  return parsed;
}

/**
 * Resolve a network name into a concrete {@link NetworkConfig}.
 *
 * - `"arc-testnet"` → the static {@link NETWORKS} entry. `ARC_RPC_URL` (if
 *   set) overrides `rpcUrl`, matching pre-0.5 behavior.
 * - `"arc-mainnet"` → built entirely from `ARC_MAINNET_*` environment
 *   variables. Circle has not published Arc mainnet parameters yet; until
 *   every required variable is set this throws a single error listing all
 *   missing ones. Source of truth once published: ${MAINNET_DOCS_URL}.
 *
 * @param env Environment map to read from (defaults to `process.env`) —
 *   injectable for tests and non-Node runtimes.
 */
export function resolveNetwork(name: NetworkName, env: Env = process.env): NetworkConfig {
  if (name === "arc-testnet") {
    const base = NETWORKS["arc-testnet"];
    return {
      ...base,
      contracts: { ...base.contracts },
      rpcUrl: readEnv(env, "ARC_RPC_URL") ?? base.rpcUrl,
    };
  }

  if (name === "arc-mainnet") {
    const missing = MAINNET_REQUIRED_VARS.filter(key => readEnv(env, key) === undefined);
    if (missing.length > 0) {
      throw new Error(
        `resolveNetwork("arc-mainnet"): Arc mainnet is not configured — missing environment ` +
        `variable(s): ${missing.join(", ")}. Circle publishes the official chain parameters and ` +
        `contract addresses at ${MAINNET_DOCS_URL} (source of truth) — never guess them. ` +
        `Set the variables once published, or use network "arc-testnet" until then.`,
      );
    }

    const chainId = parseIntStrict("ARC_MAINNET_CHAIN_ID", readEnv(env, "ARC_MAINNET_CHAIN_ID")!);
    const agenticCommerce    = readEnv(env, "ARC_MAINNET_AGENTIC_COMMERCE")!;
    const identityRegistry   = readEnv(env, "ARC_MAINNET_IDENTITY_REGISTRY")!;
    const reputationRegistry = readEnv(env, "ARC_MAINNET_REPUTATION_REGISTRY")!;
    const usdc               = readEnv(env, "ARC_MAINNET_USDC")!;
    const bountyAdapter      = readEnv(env, "ARC_MAINNET_BOUNTY_ADAPTER");

    requireAddress([
      ["ARC_MAINNET_AGENTIC_COMMERCE",    agenticCommerce],
      ["ARC_MAINNET_IDENTITY_REGISTRY",   identityRegistry],
      ["ARC_MAINNET_REPUTATION_REGISTRY", reputationRegistry],
      ["ARC_MAINNET_USDC",                usdc],
      ...(bountyAdapter ? [["ARC_MAINNET_BOUNTY_ADAPTER", bountyAdapter] as [string, string]] : []),
    ]);

    const deployBlockRaw   = readEnv(env, "ARC_MAINNET_ADAPTER_DEPLOY_BLOCK");
    const blocksPerDayRaw  = readEnv(env, "ARC_MAINNET_BLOCKS_PER_DAY");

    return {
      chainId,
      name: "Arc",
      caip2: `eip155:${chainId}`,
      rpcUrl:         readEnv(env, "ARC_MAINNET_RPC_URL")!,
      explorerUrl:    readEnv(env, "ARC_MAINNET_EXPLORER_URL")!,
      explorerApiUrl: readEnv(env, "ARC_MAINNET_EXPLORER_API_URL")!,
      contracts: {
        AGENTIC_COMMERCE:    agenticCommerce as Address,
        IDENTITY_REGISTRY:   identityRegistry as Address,
        REPUTATION_REGISTRY: reputationRegistry as Address,
        USDC:                usdc as Address,
      },
      ...(bountyAdapter ? { defaultBountyAdapter: bountyAdapter as Address } : {}),
      ...(deployBlockRaw !== undefined
        ? { adapterDeployBlock: parseIntStrict("ARC_MAINNET_ADAPTER_DEPLOY_BLOCK", deployBlockRaw, 0) }
        : {}),
      testnet: false,
      blocksPerDay: blocksPerDayRaw !== undefined
        ? parseIntStrict("ARC_MAINNET_BLOCKS_PER_DAY", blocksPerDayRaw)
        : NETWORKS["arc-testnet"].blocksPerDay,
    };
  }

  throw new Error(`resolveNetwork: unknown network "${name as string}" (expected "arc-testnet" or "arc-mainnet")`);
}

// ─── Deprecated aliases (0.4.x compatibility) ────────────────────────────────

/** @deprecated Use `NETWORKS["arc-testnet"].rpcUrl` or `resolveNetwork(name).rpcUrl`. */
export const ARC_TESTNET_RPC = NETWORKS["arc-testnet"].rpcUrl;
/** @deprecated Use `NETWORKS["arc-testnet"].chainId` or `resolveNetwork(name).chainId`. */
export const ARC_TESTNET_CHAIN_ID = NETWORKS["arc-testnet"].chainId;
/** @deprecated Use `NETWORKS["arc-testnet"].contracts` or `resolveNetwork(name).contracts`. */
export const CONTRACTS = NETWORKS["arc-testnet"].contracts;

export const USDC_DECIMALS = 6;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

// Mirrors BountyAdapter's bond-deadline constants (V4.1 creation floor, V4.2
// take window). The contract is the source of truth on-chain; these exist so
// the SDK can fail fast client-side with a clearer error — the take-window
// guard also protects agents talking to pre-V4.2 deployments, which don't
// enforce it on-chain yet.
export const MIN_BOND_BOUNTY_DURATION_SEC = 24n * 3600n;
export const MIN_BOND_TAKE_WINDOW_SEC = 12n * 3600n;
// Client clocks lag block.timestamp (mining delay, skew — Arc testnet has
// been observed running ahead of wall time). Deadline checks done "exactly
// at the floor" client-side would pass here and revert on-chain seconds
// later, after the poster already paid for the approve tx.
export const DEADLINE_SAFETY_BUFFER_SEC = 15n * 60n;

export const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];
