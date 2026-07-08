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

// Mirrors BountyAdapter's bond-deadline constants (V4.1 creation floor, V4.2
// take window). The contract is the source of truth on-chain; these exist so
// the SDK can fail fast client-side with a clearer error — the take-window
// guard also protects agents talking to pre-V4.2 deployments, which don't
// enforce it on-chain yet.
export const MIN_BOND_BOUNTY_DURATION_SEC = 24n * 3600n;
export const MIN_BOND_TAKE_WINDOW_SEC = 12n * 3600n;
// Client clocks lag block.timestamp (mining delay, skew — Arc testnet has
// been observed running ahead of wall time). Deadline checks done "exactly
// at the floor" client-side would pass here and revert on-chain seconds
// later, after the poster already paid for the approve tx.
export const DEADLINE_SAFETY_BUFFER_SEC = 15n * 60n;

export const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];
