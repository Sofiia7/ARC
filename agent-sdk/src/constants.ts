import { isAddress, type Address } from "viem";

// ─── Networks ────────────────────────────────────────────────────────────────

export type NetworkName = "arc-testnet" | "arc-mainnet" | "base-sepolia";

/**
 * The chain's native (gas) token.
 *
 * This is the one place Arc and Base genuinely diverge for callers: on Arc,
 * USDC *is* the native token, so a wallet holding only USDC can transact. On
 * Base, USDC is an ordinary ERC-20 and gas is paid in ETH — an agent or human
 * funded only with USDC will fail at the first transaction. Anything that
 * tells a user what to fund their wallet with must branch on `isUsdc` rather
 * than assume Arc's model.
 */
export type NativeCurrency = {
  symbol: string;
  decimals: number;
  /** True when the native gas token is USDC itself (Arc), false when gas is a separate asset (Base: ETH). */
  isUsdc: boolean;
};

/**
 * Product branding for this network's deployment.
 *
 * The Base deployment ships under its own name (BaseBounty / basebounty.app),
 * separate from the Arc one (ArcBounty / arcbounty.app) — "Arc" reads as a
 * competing chain to a Base audience. This is one codebase and one npm
 * package serving both; only the user-facing name differs, so anything that
 * renders a product name must read it from here rather than hardcode one.
 */
export type Brand = {
  name: string;
  domain: string;
};

export type NetworkConfig = {
  chainId: number;
  name: string;
  /** CAIP-2 identifier (`eip155:<chainId>`), e.g. for x402 network fields. */
  caip2: string;
  rpcUrl: string;
  explorerUrl: string;
  explorerApiUrl: string;
  /** Explorer's display name, e.g. for wallet "view on …" links. */
  explorerName: string;
  nativeCurrency: NativeCurrency;
  brand: Brand;
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
  /** Rough estimate for "last N days" style block math (≈1s/block on Arc, ≈2s on Base). */
  blocksPerDay: number;
};

/**
 * Statically known networks.
 *
 * Two mainnets are deliberately absent, for different reasons:
 *
 * - **Arc mainnet** — Circle has not published its parameters yet (chain id,
 *   RPC, contract addresses; source of truth:
 *   https://docs.arc.io/arc/references/contract-addresses). Use
 *   `resolveNetwork("arc-mainnet")`, which builds the config from
 *   `ARC_MAINNET_*` environment variables and fails with a descriptive error
 *   while they are missing.
 * - **Base mainnet (8453)** — every *external* address is already known and
 *   verified (see `docs/INTEGRATION_NOTES.md`), but our own `AgenticCommerce`
 *   escrow and `BountyAdapter` are not deployed there yet. It gets a static
 *   entry in the same commit as the deploy, with the real addresses.
 *
 * Never hardcode guessed values here — an entry exists only once every
 * address in it has been confirmed on-chain.
 */
export const NETWORKS = {
  "arc-testnet": {
    chainId: 5_042_002,
    name: "Arc Testnet",
    caip2: "eip155:5042002",
    rpcUrl: "https://rpc.testnet.arc.network",
    explorerUrl: "https://testnet.arcscan.app",
    explorerApiUrl: "https://testnet.arcscan.app/api",
    explorerName: "ArcScan",
    // Arc's native gas token IS USDC — that is the whole point of the chain.
    nativeCurrency: { symbol: "USDC", decimals: 6, isUsdc: true },
    brand: { name: "ArcBounty", domain: "arcbounty.app" },
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
  "base-sepolia": {
    chainId: 84_532,
    name: "Base Sepolia",
    caip2: "eip155:84532",
    rpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
    // Etherscan V2: one multichain endpoint keyed by `chainid`, not a
    // per-chain host (see docs/INTEGRATION_NOTES.md).
    explorerApiUrl: "https://api.etherscan.io/v2/api?chainid=84532",
    explorerName: "Basescan",
    // Unlike Arc: gas is ETH, and USDC below is an ordinary ERC-20.
    nativeCurrency: { symbol: "ETH", decimals: 18, isUsdc: false },
    brand: { name: "BaseBounty", domain: "basebounty.app" },
    contracts: {
      // Our own copy of Arc's escrow variant (contracts/src/base/) — no
      // canonical AgenticCommerce instance exists on Base.
      AGENTIC_COMMERCE:    "0x37BB41D12adC01cBFb9Ca69098F9E09E0938a673",
      // Canonical ERC-8004 registries deployed by the 8004 team — NOT ours.
      IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      USDC:                "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
    defaultBountyAdapter: "0x39e8D70BF771001d8FDa13354c2CE5c2DD6229D9",
    // Recovered by binary-searching eth_getCode (the 2026-07-20 rehearsal
    // recorded tx hashes but no block number): first block with code is
    // 44398167, 2026-07-20T16:23:42Z, matching DEPLOYMENTS.md's date.
    adapterDeployBlock: 44_398_167,
    testnet: true,
    blocksPerDay: 43_200, // ≈2s blocks
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
 * - `"base-sepolia"` → the static {@link NETWORKS} entry. `BASE_SEPOLIA_RPC_URL`
 *   (if set) overrides `rpcUrl` — the public `sepolia.base.org` node is rate
 *   limited, so a dedicated RPC is expected in CI and e2e runs.
 * - `"arc-mainnet"` → built entirely from `ARC_MAINNET_*` environment
 *   variables. Circle has not published Arc mainnet parameters yet; until
 *   every required variable is set this throws a single error listing all
 *   missing ones. Source of truth once published: ${MAINNET_DOCS_URL}.
 *
 * @param env Environment map to read from (defaults to `process.env`) —
 *   injectable for tests and non-Node runtimes.
 */
export function resolveNetwork(name: NetworkName, env: Env = process.env): NetworkConfig {
  // Statically known networks, with a per-network RPC override env var.
  const STATIC_RPC_OVERRIDE = {
    "arc-testnet":  "ARC_RPC_URL",
    "base-sepolia": "BASE_SEPOLIA_RPC_URL",
  } as const;

  if (name in STATIC_RPC_OVERRIDE) {
    const key = name as keyof typeof STATIC_RPC_OVERRIDE;
    const base = NETWORKS[key];
    return {
      ...base,
      contracts: { ...base.contracts },
      nativeCurrency: { ...base.nativeCurrency },
      brand: { ...base.brand },
      rpcUrl: readEnv(env, STATIC_RPC_OVERRIDE[key]) ?? base.rpcUrl,
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
      explorerName: "ArcScan",
      // USDC-as-native-gas is a property of Arc itself, not of its testnet.
      nativeCurrency: { symbol: "USDC", decimals: 6, isUsdc: true },
      brand: { name: "ArcBounty", domain: "arcbounty.app" },
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

  throw new Error(
    `resolveNetwork: unknown network "${name as string}" ` +
    `(expected "arc-testnet", "arc-mainnet" or "base-sepolia")`,
  );
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
