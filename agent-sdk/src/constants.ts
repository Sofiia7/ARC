import type { Address } from "viem";

// ─── Networks ────────────────────────────────────────────────────────────────

export type NetworkName = "arc-testnet" | "arc-mainnet" | "base-sepolia" | "base-mainnet";

/**
 * The chain's native (gas) token.
 *
 * This is the one place Arc and Base genuinely diverge for callers: on Arc,
 * USDC *is* the native token, so a wallet holding only USDC can transact. On
 * Base, USDC is an ordinary ERC-20 and gas is paid in ETH - an agent or human
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
 * separate from the Arc one (ArcBounty / arcbounty.app) - "Arc" reads as a
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
  /** Block the canonical adapter was deployed at - lower bound for log scans. */
  adapterDeployBlock?: number;
  testnet: boolean;
  /** Rough estimate for "last N days" style block math (≈1s/block on Arc, ≈2s on Base). */
  blocksPerDay: number;
};

/**
 * Statically known networks - all four, since Arc mainnet opened on
 * 2026-09-16 (parameters: https://docs.arc.io/arc/references/rpc-endpoints).
 *
 * Never hardcode guessed values here - an entry exists only once every
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
    // Arc's native gas token IS USDC - that is the whole point of the chain.
    // 18 decimals, not 6: USDC on Arc has two interfaces over one balance, the
    // native one (eth_getBalance, gas, what a wallet shows) at 18 and the
    // ERC-20 at 0x3600…0000 at 6 (USDC_DECIMALS below). See docs.arc.io,
    // "EVM differences".
    nativeCurrency: { symbol: "USDC", decimals: 18, isUsdc: true },
    // arcbounty.app itself serves Arc mainnet since 2026-09-16.
    brand: { name: "ArcBounty", domain: "testnet.arcbounty.app" },
    contracts: {
      AGENTIC_COMMERCE:    "0x0747EEf0706327138c69792bF28Cd525089e4583",
      IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      USDC:                "0x3600000000000000000000000000000000000000",
    },
    // V4.7 (2026-09-07): audit fixes C-01/C-02/M-01/M-07/M-08 - see contracts/DEPLOYMENTS.md.
    defaultBountyAdapter: "0xeDf2c738915b042da97788b2b5499D4655FB1f20",
    adapterDeployBlock: 60_965_136,
    testnet: true,
    blocksPerDay: 86_400,
  },
  "arc-mainnet": {
    chainId: 5_042,
    name: "Arc",
    caip2: "eip155:5042",
    // Blockdaemon, not Circle's own rpc.mainnet.arc.io, though docs.arc.io
    // lists both: Circle's node refuses eth_getLogs over 10,000 blocks, the
    // chunk every log scan here uses, while Blockdaemon's public endpoint
    // serves 100,000 with CORS open (both checked 2026-09-16).
    rpcUrl: "https://rpc.blockdaemon.mainnet.arc.io",
    // Circle's explorer. At launch it still sits behind a Circle sign-in, so
    // links reach a login page until Circle opens it to the public.
    explorerUrl: "https://explorer.arc.io",
    explorerApiUrl: "https://explorer.arc.io/api",
    explorerName: "Arc Explorer",
    nativeCurrency: { symbol: "USDC", decimals: 18, isUsdc: true },
    brand: { name: "ArcBounty", domain: "arcbounty.app" },
    contracts: {
      // Our own copy of the escrow (contracts/src/base/), exactly as on Base:
      // Arc mainnet has no canonical ERC-8183 instance. Its upgrade authority
      // is the arbitrator Safe, never a deployer key.
      AGENTIC_COMMERCE:    "0x64cA39Fc57315D0D488acCaC07c37C6E841CD058",
      // The 8004 team's mainnet registries: the same addresses and the same
      // implementations as on Base mainnet, verified on chain 5042 itself.
      IDENTITY_REGISTRY:   "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      REPUTATION_REGISTRY: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      USDC:                "0x3600000000000000000000000000000000000000",
    },
    // V4.7, 2026-09-16 (contracts/script/DeployArcMainnet.s.sol).
    defaultBountyAdapter: "0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D",
    adapterDeployBlock: 21_153_190,
    testnet: false,
    blocksPerDay: 170_000, // ≈0.51s blocks, averaged over 100,000 blocks on 2026-09-16
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
      // Our own copy of Arc's escrow variant (contracts/src/base/) - no
      // canonical AgenticCommerce instance exists on Base.
      AGENTIC_COMMERCE:    "0xbe6e78207140d21d5FcF5595Ad396e482f1Cd384",
      // Canonical ERC-8004 registries deployed by the 8004 team - NOT ours.
      IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      USDC:                "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
    defaultBountyAdapter: "0x32EC90A4dad0bbdFF0eF44461c353aC5C02757F4",
    // V4.6 staging deploy, 2026-08-13 (from the forge broadcast receipt).
    adapterDeployBlock: 45_438_882,
    testnet: true,
    blocksPerDay: 43_200, // ≈2s blocks
  },
  "base-mainnet": {
    chainId: 8_453,
    name: "Base",
    caip2: "eip155:8453",
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    // Etherscan V2: one multichain endpoint keyed by `chainid`, not a
    // per-chain host (see docs/INTEGRATION_NOTES.md).
    explorerApiUrl: "https://api.etherscan.io/v2/api?chainid=8453",
    explorerName: "Basescan",
    // Unlike Arc: gas is ETH, and USDC below is an ordinary ERC-20.
    nativeCurrency: { symbol: "ETH", decimals: 18, isUsdc: false },
    brand: { name: "BaseBounty", domain: "basebounty.app" },
    contracts: {
      // Our own copy of Arc's escrow variant (contracts/src/base/) - no
      // canonical AgenticCommerce instance exists on Base.
      AGENTIC_COMMERCE:    "0x6D9317eC0Fca3aFd5439d539064DBA94197c4AC4",
      // Canonical ERC-8004 registries deployed by the 8004 team - NOT ours.
      IDENTITY_REGISTRY:   "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      REPUTATION_REGISTRY: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      USDC:                "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    defaultBountyAdapter: "0x9b0B27c20DF10BFc667F4316d7175166Ff8c4c2c",
    // V4.6 mainnet deploy, 2026-08-14 (from the forge broadcast receipt).
    adapterDeployBlock: 50_576_208,
    testnet: false,
    blocksPerDay: 43_200, // ≈2s blocks
  },
} as const satisfies Record<string, NetworkConfig>;

type Env = Record<string, string | undefined>;

function readEnv(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/**
 * Resolve a network name into a concrete {@link NetworkConfig}: a copy of the
 * static {@link NETWORKS} entry, with that network's own RPC override applied
 * if set. Each network reads only its own variable, so a testnet RPC left in
 * a long-lived `.env` never reaches a mainnet run:
 *
 * - `"arc-testnet"` → `ARC_RPC_URL`, matching pre-0.5 behavior.
 * - `"arc-mainnet"` → `ARC_MAINNET_RPC_URL`. The default (Blockdaemon) serves
 *   the 10,000-block log ranges the SDK scans; an override must too.
 * - `"base-sepolia"` → `BASE_SEPOLIA_RPC_URL` - the public `sepolia.base.org`
 *   node is rate limited, so a dedicated RPC is expected in CI and e2e runs.
 * - `"base-mainnet"` → `BASE_MAINNET_RPC_URL`; the public `mainnet.base.org`
 *   node is rate limited and also load-balanced, so reads issued immediately
 *   after a receipt can hit a lagging node.
 *
 * @param env Environment map to read from (defaults to `process.env`) -
 *   injectable for tests and non-Node runtimes.
 */
export function resolveNetwork(name: NetworkName, env: Env = process.env): NetworkConfig {
  // Statically known networks, with a per-network RPC override env var.
  const STATIC_RPC_OVERRIDE = {
    "arc-testnet":  "ARC_RPC_URL",
    "arc-mainnet":  "ARC_MAINNET_RPC_URL",
    "base-sepolia": "BASE_SEPOLIA_RPC_URL",
    "base-mainnet": "BASE_MAINNET_RPC_URL",
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

  throw new Error(
    `resolveNetwork: unknown network "${name as string}" ` +
    `(expected "arc-testnet", "arc-mainnet", "base-sepolia" or "base-mainnet")`,
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
// the SDK can fail fast client-side with a clearer error - the take-window
// guard also protects agents talking to pre-V4.2 deployments, which don't
// enforce it on-chain yet.
export const MIN_BOND_BOUNTY_DURATION_SEC = 24n * 3600n;
export const MIN_BOND_TAKE_WINDOW_SEC = 12n * 3600n;
// Client clocks lag block.timestamp (mining delay, skew - Arc testnet has
// been observed running ahead of wall time). Deadline checks done "exactly
// at the floor" client-side would pass here and revert on-chain seconds
// later, after the poster already paid for the approve tx.
export const DEADLINE_SAFETY_BUFFER_SEC = 15n * 60n;

export const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];
