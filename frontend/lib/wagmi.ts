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
  ],
  ssr: true,
});
