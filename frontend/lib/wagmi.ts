import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected, walletConnect } from "wagmi/connectors";
import { porto } from "porto/wagmi";
import { getActiveNetwork, MULTICALL3_ADDRESS } from "./networks";

const network = getActiveNetwork();

// NEXT_PUBLIC_RPC_URL keeps overriding the active network's RPC exactly as it
// always has (pre-multi-network behavior, arc-testnet only — mainnet's RPC
// comes from NEXT_PUBLIC_ARC_MAINNET_RPC_URL, part of lib/networks.ts).
const rpcUrl = network.testnet
  ? (process.env.NEXT_PUBLIC_RPC_URL ?? network.rpcUrl)
  : network.rpcUrl;

export const activeChain = defineChain({
  id: network.chainId,
  name: network.name,
  // Arc's native gas token IS USDC (6 decimals) — that's the whole point of
  // the network. Must match agent-sdk's chain definition exactly, or wallets
  // render balances off by 10^12.
  nativeCurrency: {
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: {
    default: { http: [rpcUrl] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: network.explorerUrl },
  },
  // Multicall3 at the canonical cross-chain address. Without this entry viem
  // has no way to aggregate reads, so every `useReadContracts` degrades into
  // one eth_call per bounty — the public RPC answers ~1 in 6 of those with
  // HTTP 429, the metas come back empty and the board renders "No open
  // bounties found" while bounties are open on-chain. See
  // NetworkConfig.multicall3 in lib/networks.ts for the mainnet caveat.
  ...(network.multicall3
    ? { contracts: { multicall3: { address: MULTICALL3_ADDRESS } } }
    : {}),
  testnet: network.testnet,
});

// The public Arc RPC rate-limits aggressively per IP, so a single visitor can
// exhaust it on one page load. `batch` coalesces concurrent eth_calls into one
// JSON-RPC request; the retries ride out the 429s that still slip through.
const arcTransport = http(rpcUrl, {
  batch: { wait: 16 },
  retryCount: 3,
  retryDelay: 400,
});

export const config = createConfig({
  chains: [activeChain],
  transports: {
    [activeChain.id]: arcTransport,
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
