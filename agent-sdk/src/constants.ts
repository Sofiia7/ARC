import type { Address } from "viem";

export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network";
export const ARC_TESTNET_CHAIN_ID = 5_042_002;

export const CONTRACTS = {
  AGENTIC_COMMERCE:    "0x0747EEf0706327138c69792bF28Cd525089e4583" as Address,
  IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
  USDC:                "0x3600000000000000000000000000000000000000" as Address,
} as const;

export const USDC_DECIMALS = 6;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];
