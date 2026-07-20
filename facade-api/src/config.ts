import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_RPC } from "./sdk.js";
import type { Address } from "viem";
import { isAddress } from "viem";

export const VERSION = "0.1.0";

// x402 v2 uses CAIP-2 network identifiers. Arc mainnet (eip155:5042) is
// pre-GA/private as of 2026-07 (see docs/INTEGRATION_NOTES.md) — testnet only.
export const ARC_TESTNET_CAIP2 = `eip155:${ARC_TESTNET_CHAIN_ID}` as const;

// Prices per TZ (Part2_Base). Declared once so /openapi.json,
// /.well-known/x402.json and the actual middleware can never disagree.
export const PRICES = {
  listBounties: "$0.001",
  getBounty: "$0.001",
  getSubmissions: "$0.001",
  prepareBounty: "$0.01",
} as const;

export type FacadeConfig = {
  port: number;
  rpcUrl: string;
  bountyAdapterAddress: Address;
  /** Wallet that receives x402 payments. Unset → free mode (no 402s), for local dev/CI. */
  sellerAddress: Address | null;
  /** Circle Gateway facilitator. Default: testnet facilitator, matching Arc Testnet settlement. */
  facilitatorUrl: string;
  cacheTtlMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacadeConfig {
  // trim() everywhere: env values written through Windows shells arrive with
  // trailing \r, which silently fails isAddress() and URL parsing.
  const clean = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v === "" ? undefined : v;
  };

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
    port: Number(clean("PORT") ?? 8402),
    rpcUrl: clean("ARC_RPC_URL") ?? ARC_TESTNET_RPC,
    bountyAdapterAddress: bountyAdapterAddress as Address,
    sellerAddress: (sellerRaw as Address | undefined) ?? null,
    facilitatorUrl: clean("FACILITATOR_URL") ?? "https://gateway-api-testnet.circle.com",
    cacheTtlMs: Number(clean("CACHE_TTL_MS") ?? 20_000),
  };
}
