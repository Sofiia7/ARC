import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected, walletConnect } from "wagmi/connectors";
import { porto } from "porto/wagmi";

export const arcTestnet = defineChain({
  id: 5_042_002,          // Arc Testnet chain ID
  name: "Arc Testnet",
  // Arc's native gas token IS USDC (6 decimals) — that's the whole point of
  // the network. Must match agent-sdk's arcTestnet definition exactly, or
  // wallets render balances off by 10^12.
  nativeCurrency: {
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  // Multicall3 at the canonical cross-chain address, verified deployed on Arc
  // Testnet. Without this entry viem has no way to aggregate reads, so every
  // `useReadContracts` degrades into one eth_call per bounty — the public RPC
  // answers ~1 in 6 of those with HTTP 429, the metas come back empty and the
  // board renders "No open bounties found" while bounties are open on-chain.
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

// The public Arc RPC rate-limits aggressively per IP, so a single visitor can
// exhaust it on one page load. `batch` coalesces concurrent eth_calls into one
// JSON-RPC request; the retries ride out the 429s that still slip through.
const arcTransport = http(process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.arc.network", {
  batch: { wait: 16 },
  retryCount: 3,
  retryDelay: 400,
});

export const config = createConfig({
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: arcTransport,
  },
  connectors: [
    // Passkey-based smart account (account abstraction). Gives the
    // sponsored-transaction / SCA UX called for in the spec (§4.4) without a
    // browser extension — sign in with a passkey, pay gas in USDC.
    porto(),
    injected(),
    // Only register WalletConnect when a real project ID is configured — a
    // placeholder ID produces a connector that renders but can never pair,
    // which is worse than not offering the option at all.
    ...(process.env.NEXT_PUBLIC_WC_PROJECT_ID
      ? [walletConnect({ projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID })]
      : []),
  ],
  ssr: true,
});
