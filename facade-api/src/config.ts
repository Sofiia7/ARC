import { resolveNetwork, type NetworkName } from "./sdk.js";
import type { Address } from "viem";
import { isAddress } from "viem";

export const VERSION = "0.1.0";

// Circle Gateway facilitator defaults, per network. FACILITATOR_URL env
// always wins when set.
const FACILITATOR_DEFAULTS: Record<NetworkName, string> = {
  "arc-testnet": "https://gateway-api-testnet.circle.com",
  "arc-mainnet": "https://gateway-api.circle.com",
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
  /** Which Arc network this deployed instance serves. One instance = one network. */
  network: NetworkName;
  /** Human-readable network name from the resolved config (e.g. "Arc Testnet" / "Arc"). */
  networkName: string;
  chainId: number;
  /** x402 v2 CAIP-2 network identifier (`eip155:<chainId>`), from the resolved network config. */
  caip2: string;
  port: number;
  rpcUrl: string;
  /** USDC token address for this network — from the resolved network config. */
  usdcAddress: Address;
  bountyAdapterAddress: Address;
  /** Wallet that receives x402 payments. Unset → free mode (no 402s), for local dev/CI. */
  sellerAddress: Address | null;
  /** Circle Gateway facilitator. Default: per-network facilitator (see FACILITATOR_DEFAULTS). */
  facilitatorUrl: string;
  cacheTtlMs: number;
};

function parseNetwork(raw: string | undefined): NetworkName {
  const value = raw ?? "arc-testnet";
  if (value !== "arc-testnet" && value !== "arc-mainnet") {
    throw new Error(`NETWORK must be "arc-testnet" or "arc-mainnet", got "${value}"`);
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
      "BOUNTY_ADAPTER_ADDRESS missing or invalid — see contracts/DEPLOYMENTS.md for the canonical address",
    );
  }

  const sellerRaw = clean("SELLER_ADDRESS");
  if (sellerRaw && !isAddress(sellerRaw)) {
    throw new Error(`SELLER_ADDRESS is set but not a valid address: ${sellerRaw}`);
  }

  return {
    network,
    networkName: resolved.name,
    chainId: resolved.chainId,
    caip2: resolved.caip2,
    port: Number(clean("PORT") ?? 8402),
    rpcUrl: clean("ARC_RPC_URL") ?? resolved.rpcUrl,
    usdcAddress: resolved.contracts.USDC,
    bountyAdapterAddress: bountyAdapterAddress as Address,
    sellerAddress: (sellerRaw as Address | undefined) ?? null,
    facilitatorUrl: clean("FACILITATOR_URL") ?? FACILITATOR_DEFAULTS[network],
    cacheTtlMs: Number(clean("CACHE_TTL_MS") ?? 20_000),
  };
}
