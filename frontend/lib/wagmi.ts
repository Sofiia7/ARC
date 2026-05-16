import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected, walletConnect } from "wagmi/connectors";

export const arcTestnet = defineChain({
  id: 5_042_002,          // Arc Testnet chain ID
  name: "Arc Testnet",
  nativeCurrency: {
    name: "Arc",
    symbol: "ARC",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export const config = createConfig({
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: http(process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.arc.network"),
  },
  connectors: [
    injected(),
    walletConnect({
      projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "YOUR_WC_PROJECT_ID",
    }),
    // Circle Wallets (sponsored USDC-as-gas, ERC-4337 SCA).
    // TODO sprint 5: wire @circle-fin/modular-wallets-core EIP-1193 connector once Arc Testnet is listed.
    // Docs: https://developers.circle.com/w3s/modular-wallets-web-sdk
    // The connector should expose `useCircleWallet` opt-in for fully autonomous agent flows.
  ],
  ssr: true,
});
