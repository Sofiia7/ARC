import type { Address } from "viem";

// ─── Networks ────────────────────────────────────────────────────────────────
//
// One build = one network. The active network is chosen at BUILD time by
// NEXT_PUBLIC_ARC_NETWORK (default "arc-testnet") - production ships as one
// Vercel project per network, each with its own env vars and domain.
// See frontend/README.md.
//
// This is the frontend's OWN copy of the network map, not the
// `arcbounty-agent-sdk` package's `agent-sdk/src/constants.ts` - a Vercel
// build must never wait on an npm publish. scripts/check-consistency.ts
// guards the two maps against drifting apart, so keep field names and
// per-network values mirrored when editing either one.

export type NetworkName = "arc-testnet" | "arc-mainnet" | "base-sepolia" | "base-mainnet";

/**
 * The chain's native (gas) token - mirrors `NativeCurrency` in the SDK.
 *
 * The one place Arc and Base genuinely diverge for users: on Arc, USDC *is*
 * the native token, so a wallet holding only USDC can transact. On Base, USDC
 * is an ordinary ERC-20 and gas is paid in ETH - someone funded only with
 * USDC will fail at the first transaction. Every piece of copy telling a user
 * what to put in their wallet must branch on `isUsdc`.
 */
export type NativeCurrency = {
  symbol: string;
  decimals: number;
  isUsdc: boolean;
};

/**
 * Product branding for this build - mirrors `Brand` in the SDK.
 *
 * The Base build ships as BaseBounty (basebounty.app), the Arc build as
 * ArcBounty (arcbounty.app): "Arc" reads as a competing chain to a Base
 * audience. One codebase, one build per network, so the product name is a
 * network field rather than a hardcoded string.
 */
export type Brand = {
  name: string;
  domain: string;
};

export type NetworkConfig = {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  explorerApiUrl: string;
  /** Explorer's display name, e.g. for wallet "view on …" links. */
  explorerName: string;
  /**
   * Whether users must add this chain to their wallet by hand.
   *
   * True for Arc: wallets don't ship it, so onboarding has to walk through
   * the RPC/chain-id form. False for Base, which every wallet has had
   * preloaded for years - telling a Base user how to "add Base" reads as
   * though we've never met one. Frontend-only concern, so it deliberately
   * has no counterpart in the SDK's map.
   */
  needsWalletSetup: boolean;
  nativeCurrency: NativeCurrency;
  brand: Brand;
  contracts: {
    AGENTIC_COMMERCE: Address;
    IDENTITY_REGISTRY: Address;
    REPUTATION_REGISTRY: Address;
    USDC: Address;
  };
  /**
   * Default BountyAdapter for this network. `NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS`
   * still overrides this exactly as it always has - see lib/contracts.ts.
   * Undefined on arc-testnet on purpose: that network has never had a baked-in
   * default, `NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS` has always been mandatory
   * there, and this keeps that behavior unchanged.
   */
  bountyAdapterAddress?: Address;
  /** Deployment block of the adapter - lower bound for chunked event scans. */
  adapterDeployBlock: bigint;
  /**
   * Whether the canonical Multicall3 deployment (see MULTICALL3_ADDRESS) is
   * live on this network. Verified on-chain for every entry below, never
   * assumed: eth_getCode at the canonical address returns bytecode.
   */
  multicall3: boolean;
  testnet: boolean;
  /** Rough estimate for "last N days" style block math (≈1s/block on Arc, ≈2s on Base). */
  blocksPerDay: bigint;
  /** Fallback RPC log-scan bound - see lib/chainLogs.ts. */
  maxLookbackBlocks: bigint;
};

/** Canonical cross-chain Multicall3 address (see NetworkConfig.multicall3). */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Statically known networks - all four, since Arc mainnet opened on
 * 2026-09-16.
 *
 * Never hardcode guessed values here.
 */
export const NETWORKS = {
  "arc-testnet": {
    chainId: 5_042_002,
    name: "Arc Testnet",
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.arc.network",
    explorerUrl: "https://testnet.arcscan.app",
    explorerApiUrl: "https://testnet.arcscan.app/api",
    explorerName: "ArcScan",
    // Wallets do not ship Arc - onboarding must walk through adding it.
    needsWalletSetup: true,
    // Arc's native gas token IS USDC - that is the whole point of the chain.
    // 18 decimals natively (eth_getBalance, gas, the wallet's balance line);
    // the ERC-20 interface at 0x3600…0000 is the 6-decimal one.
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
    adapterDeployBlock: 60_965_136n,
    multicall3: true,
    testnet: true,
    blocksPerDay: 86_400n,
    maxLookbackBlocks: 500_000n,
  },
  "arc-mainnet": {
    chainId: 5_042,
    name: "Arc",
    // Blockdaemon, not Circle's own rpc.mainnet.arc.io: Circle's node refuses
    // eth_getLogs over 10,000 blocks, the chunk lib/chainLogs.ts scans in,
    // while Blockdaemon's serves 100,000 with CORS open (checked 2026-09-16).
    // An override must serve 10,000-block log ranges too.
    rpcUrl: process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL ?? "https://rpc.blockdaemon.mainnet.arc.io",
    // Circle's explorer. At launch it still sits behind a Circle sign-in, so
    // the log API falls back to the bounded RPC scan until Circle opens it.
    explorerUrl: "https://explorer.arc.io",
    explorerApiUrl: "https://explorer.arc.io/api",
    explorerName: "Arc Explorer",
    needsWalletSetup: true,
    nativeCurrency: { symbol: "USDC", decimals: 18, isUsdc: true },
    brand: { name: "ArcBounty", domain: "arcbounty.app" },
    contracts: {
      // Our own copy of the escrow, exactly as on Base: Arc mainnet has no
      // canonical ERC-8183 instance. Upgrade authority: the arbitrator Safe.
      AGENTIC_COMMERCE:    "0x64cA39Fc57315D0D488acCaC07c37C6E841CD058",
      // The 8004 team's mainnet registries - same addresses and implementations
      // as Base mainnet, verified on chain 5042 itself.
      IDENTITY_REGISTRY:   "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      REPUTATION_REGISTRY: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      USDC:                "0x3600000000000000000000000000000000000000",
    },
    // One adapter, baked in as the default, as on Base.
    bountyAdapterAddress: "0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D",
    // V4.7, 2026-09-16 (contracts/script/DeployArcMainnet.s.sol).
    adapterDeployBlock: 21_153_190n,
    multicall3: true,
    testnet: false,
    blocksPerDay: 170_000n, // ≈0.51s blocks
    maxLookbackBlocks: 500_000n,
  },
  "base-sepolia": {
    chainId: 84_532,
    name: "Base Sepolia",
    rpcUrl: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
    // Etherscan V2: one multichain endpoint keyed by `chainid`.
    explorerApiUrl: "https://api.etherscan.io/v2/api?chainid=84532",
    explorerName: "Basescan",
    // Every wallet has shipped Base for years.
    needsWalletSetup: false,
    // Unlike Arc: gas is ETH, and USDC below is an ordinary ERC-20.
    nativeCurrency: { symbol: "ETH", decimals: 18, isUsdc: false },
    brand: { name: "BaseBounty", domain: "basebounty.app" },
    contracts: {
      // Our own copy of Arc's escrow variant - no canonical instance on Base.
      AGENTIC_COMMERCE:    "0xbe6e78207140d21d5FcF5595Ad396e482f1Cd384",
      // Canonical ERC-8004 registries deployed by the 8004 team - NOT ours.
      IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      USDC:                "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
    // Unlike arc-testnet, Base has a baked-in default: the rehearsal deploy is
    // the only adapter there. NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS still wins.
    bountyAdapterAddress: "0x32EC90A4dad0bbdFF0eF44461c353aC5C02757F4",
    // V4.6 staging deploy, 2026-08-13 (from the forge broadcast receipt).
    adapterDeployBlock: 45_438_882n,
    // Verified on-chain, not assumed: eth_getCode at the canonical Multicall3
    // address returns bytecode on both Base Sepolia and Base mainnet.
    multicall3: true,
    testnet: true,
    blocksPerDay: 43_200n, // ≈2s blocks
    maxLookbackBlocks: 500_000n,
  },
  "base-mainnet": {
    chainId: 8_453,
    name: "Base",
    rpcUrl: process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    // Etherscan V2: one multichain endpoint keyed by `chainid`.
    explorerApiUrl: "https://api.etherscan.io/v2/api?chainid=8453",
    explorerName: "Basescan",
    // Every wallet has shipped Base for years.
    needsWalletSetup: false,
    // Unlike Arc: gas is ETH, and USDC below is an ordinary ERC-20.
    nativeCurrency: { symbol: "ETH", decimals: 18, isUsdc: false },
    brand: { name: "BaseBounty", domain: "basebounty.app" },
    contracts: {
      // Our own copy of Arc's escrow variant - no canonical instance on Base.
      AGENTIC_COMMERCE:    "0x6D9317eC0Fca3aFd5439d539064DBA94197c4AC4",
      // Canonical ERC-8004 registries deployed by the 8004 team - NOT ours.
      IDENTITY_REGISTRY:   "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      REPUTATION_REGISTRY: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      USDC:                "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    // Same as Base Sepolia: one adapter, baked in as the default.
    // NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS still wins.
    bountyAdapterAddress: "0x9b0B27c20DF10BFc667F4316d7175166Ff8c4c2c",
    // V4.6 mainnet deploy, 2026-08-14 (from the forge broadcast receipt).
    adapterDeployBlock: 50_576_208n,
    // Verified on-chain, not assumed: eth_getCode at the canonical Multicall3
    // address returns bytecode on both Base Sepolia and Base mainnet.
    multicall3: true,
    testnet: false,
    blocksPerDay: 43_200n, // ≈2s blocks
    maxLookbackBlocks: 500_000n,
  },
} as const satisfies Record<NetworkName, NetworkConfig>;

/** Resolve a network name into its static {@link NETWORKS} entry. */
export function resolveNetwork(name: NetworkName): NetworkConfig {
  return NETWORKS[name];
}

/** Which network this build targets - `NEXT_PUBLIC_ARC_NETWORK`, default `"arc-testnet"`. */
export function getActiveNetworkName(): NetworkName {
  const raw = process.env.NEXT_PUBLIC_ARC_NETWORK;
  if (!raw || raw === "arc-testnet") return "arc-testnet";
  if (raw === "arc-mainnet") return "arc-mainnet";
  if (raw === "base-sepolia") return "base-sepolia";
  if (raw === "base-mainnet") return "base-mainnet";
  throw new Error(
    `[arcbounty] NEXT_PUBLIC_ARC_NETWORK="${raw}" is not a valid network - ` +
    `expected "arc-testnet", "arc-mainnet", "base-sepolia" or "base-mainnet".`,
  );
}

/**
 * Product name and domain for this build - see {@link Brand}.
 *
 * Use this anywhere a product name is rendered (titles, metadata, copy)
 * instead of writing "ArcBounty" inline: the Base build ships as BaseBounty.
 */
export function getBrand(): Brand {
  return getActiveNetwork().brand;
}

/**
 * The npm package that installs this build's MCP server: `arcbounty-mcp` on
 * Arc, `basebounty-mcp` on Base. Both exist and both are listed in the MCP
 * Registry and on Smithery; the Base one is a shim over the Arc one, so they
 * are the same server under the name its audience recognises.
 *
 * Derived from the brand rather than mapped, because the packages are named
 * after the brands and a third network would be named the same way. Anywhere a
 * page prints an `npx …` line, print this.
 */
export function getMcpPackage(): string {
  return `${getActiveNetwork().brand.name.toLowerCase()}-mcp`;
}

/**
 * True when this build's chain pays gas in USDC (Arc), false when gas is a
 * separate asset (Base: ETH).
 *
 * Guard every "USDC is the gas token / you need no second asset" claim with
 * this. On Base the opposite is true and the user needs ETH *as well as*
 * USDC - copy that silently carries Arc's model over breaks onboarding.
 */
export function isGasPaidInUsdc(): boolean {
  return getActiveNetwork().nativeCurrency.isUsdc;
}

/** Resolved config for the active build's network - see {@link getActiveNetworkName}. */
export function getActiveNetwork(): NetworkConfig {
  return resolveNetwork(getActiveNetworkName());
}
