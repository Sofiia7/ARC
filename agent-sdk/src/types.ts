import type { Address, Hash } from "viem";

// ─── Config ──────────────────────────────────────────────────────────────────

export type ArcBountyAgentConfig = {
  /** Private key of the agent wallet (0x-prefixed hex) */
  privateKey: Hash;
  /** Arc RPC URL */
  rpcUrl?: string;
  /** IPFS metadata URI for agent registration (ipfs://Qm...) */
  metadataURI?: string;
  /** BountyAdapter contract address (overrides default) */
  bountyAdapterAddress?: Address;
};

// ─── On-chain structs (mirror BountyAdapter.sol BountyMeta) ──────────────────

export type BountyMeta = {
  jobId:               bigint;
  poster:              Address;
  reward:              bigint;
  deadline:            bigint;
  ipfsDescHash:        string;
  category:            string;
  tags:                readonly string[];
  agentId:             bigint;
  agentOnly:           boolean;
  humanOnly:           boolean;
  whitelistedProvider: Address;
  assignedProvider:    Address;
  submittedResultHash: string;
  submittedAt:         bigint;
  isTaken:             boolean;
  // Pending-rejection state
  rejectedAt:          bigint;
  rejectionReasonHash: string;
  // Dispute state
  inDispute:           boolean;
  resolved:            boolean;
  disputeInitiator:    Address;
  disputeRaisedAt:     bigint;
  disputeReasonHash:   string;
  disputeResponseHash: string;
  disputeRulingHash:   string;
};

export type ReputationScore = {
  averageScore:   bigint;
  totalFeedbacks: bigint;
  totalJobs:      bigint;
};

// ─── SDK-level types ──────────────────────────────────────────────────────────

export type OpenBountiesFilter = {
  category?:  string;
  agentOnly?: boolean;
  humanOnly?: boolean;
  maxReward?: number;        // in USDC dollars
  minReward?: number;
  offset?:    number;
  limit?:     number;
};

export type CreateBountyOptions = {
  /** Reward in USDC dollars (will be scaled by 1e6) */
  rewardUsdc: number;
  /** Unix seconds OR a Date OR seconds-from-now (if < 1e9 treated as duration) */
  deadline: number | Date;
  /** Pre-pinned IPFS CID for the description (ipfs://... or bafy...) */
  descriptionCid?: string;
  /** Or raw markdown — will be pinned for you */
  descriptionText?: string;
  category: "dev" | "design" | "content" | "data" | "other";
  tags?: string[];
  /** Optional whitelisted provider — only this address may take */
  provider?: Address;
  agentOnly?: boolean;
  humanOnly?: boolean;
};

export type SubmitWorkOptions = {
  /** Raw text/markdown result — will be pinned to IPFS */
  text?: string;
  /** Pre-computed IPFS CID (ipfs://...) — skips pinning */
  cid?: string;
};

export type DisputeEvidenceOptions = {
  /** Raw evidence text — will be pinned to IPFS */
  text?: string;
  /** Pre-computed IPFS CID — skips pinning */
  cid?: string;
};

export type AgentInfo = {
  agentId:     bigint;
  address:     Address;
  metadataURI: string;
  reputation:  ReputationScore;
};

export type TxResult = {
  hash: Hash;
};
