import { resolveNetwork, type NetworkName } from "./sdk.js";
import type { Address } from "viem";
import { isAddress } from "viem";

export const VERSION = "0.1.0";

// Circle Gateway facilitator defaults, per network. FACILITATOR_URL env
// always wins when set.
const FACILITATOR_DEFAULTS: Record<NetworkName, string> = {
  "arc-testnet": "https://gateway-api-testnet.circle.com",
  "arc-mainnet": "https://gateway-api.circle.com",
  // Circle's testnet Gateway. NOTE: docs/INTEGRATION_NOTES.md confirms x402
  // settlement on Base *mainnet* and Arc Testnet - Base *Sepolia* settlement
  // is not confirmed there (the Base Sepolia ✅ in those notes is about Agent
  // Wallets, a different product). Run this instance in free mode (no
  // SELLER_ADDRESS) until settlement is verified against the facilitator.
  "base-sepolia": "https://gateway-api-testnet.circle.com",
};

// Prices per TZ (Part2_Base). Declared once so /openapi.json,
// /.well-known/x402.json and the actual middleware can never disagree.
export const PRICES = {
  listBounties: "$0.001",
  getBounty: "$0.001",
  getSubmissions: "$0.001",
  prepareBounty: "$0.01",
} as const;

export type FacadeConfig = {
  /** Which network this deployed instance serves. One instance = one network. */
  network: NetworkName;
  /** Human-readable network name from the resolved config (e.g. "Arc Testnet" / "Base Sepolia"). */
  networkName: string;
  /** Product name for this network's deployment ("ArcBounty" / "BaseBounty"). */
  brandName: string;
  /**
   * Native gas token. Arc pays gas in USDC; Base pays it in ETH, so an agent
   * funded only with USDC cannot broadcast. The prepare response says which,
   * and getting it wrong silently strands callers.
   */
  nativeCurrency: { symbol: string; decimals: number; isUsdc: boolean };
  chainId: number;
  /** x402 v2 CAIP-2 network identifier (`eip155:<chainId>`), from the resolved network config. */
  caip2: string;
  port: number;
  rpcUrl: string;
  /** USDC token address for this network - from the resolved network config. */
  usdcAddress: Address;
  bountyAdapterAddress: Address;
  /** Wallet that receives x402 payments. Unset → free mode (no 402s), for local dev/CI. */
  sellerAddress: Address | null;
  /** Circle Gateway facilitator. Default: per-network facilitator (see FACILITATOR_DEFAULTS). */
  facilitatorUrl: string;
  cacheTtlMs: number;
  /**
   * Shared secret quest platforms send back to us. Unset -> the verifier is
   * open, which is the right default: it discloses nothing a block explorer
   * would not, and a key that has to exist before the first campaign can be
   * saved is a key that gets pasted wrong at 2am.
   */
  questApiKey: string | null;
};

const SUPPORTED_NETWORKS: NetworkName[] = ["arc-testnet", "arc-mainnet", "base-sepolia"];

function parseNetwork(raw: string | undefined): NetworkName {
  const value = (raw ?? "arc-testnet") as NetworkName;
  if (!SUPPORTED_NETWORKS.includes(value)) {
    throw new Error(
      `NETWORK must be one of ${SUPPORTED_NETWORKS.map(n => `"${n}"`).join(", ")}, got "${raw}"`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacadeConfig {
  // trim() everywhere: env values written through Windows shells arrive with
  // trailing \r, which silently fails isAddress() and URL parsing.
  const clean = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v === "" ? undefined : v;
  };

  const network = parseNetwork(clean("NETWORK"));
  // arc-mainnet: throws one descriptive error listing every missing
  // ARC_MAINNET_* var (source of truth: docs.arc.io/arc/references/contract-addresses).
  // arc-testnet: static config, ARC_RPC_URL already merged in by the SDK.
  const resolved = resolveNetwork(network, env);

  const bountyAdapterAddress = clean("BOUNTY_ADAPTER_ADDRESS");
  if (!bountyAdapterAddress || !isAddress(bountyAdapterAddress)) {
    throw new Error(
      "BOUNTY_ADAPTER_ADDRESS missing or invalid - see contracts/DEPLOYMENTS.md for the canonical address",
    );
  }

  const sellerRaw = clean("SELLER_ADDRESS");
  if (sellerRaw && !isAddress(sellerRaw)) {
    throw new Error(`SELLER_ADDRESS is set but not a valid address: ${sellerRaw}`);
  }

  return {
    network,
    networkName: resolved.name,
    brandName: resolved.brand.name,
    nativeCurrency: resolved.nativeCurrency,
    chainId: resolved.chainId,
    caip2: resolved.caip2,
    port: Number(clean("PORT") ?? 8402),
    rpcUrl: clean("ARC_RPC_URL") ?? resolved.rpcUrl,
    usdcAddress: resolved.contracts.USDC,
    bountyAdapterAddress: bountyAdapterAddress as Address,
    sellerAddress: (sellerRaw as Address | undefined) ?? null,
    facilitatorUrl: clean("FACILITATOR_URL") ?? FACILITATOR_DEFAULTS[network],
    cacheTtlMs: Number(clean("CACHE_TTL_MS") ?? 20_000),
    questApiKey: clean("QUEST_API_KEY") ?? null,
  };
}
