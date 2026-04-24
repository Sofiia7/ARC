import type { Address, Hash, PublicClient, WalletClient } from "viem";

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

// ─── On-chain structs ─────────────────────────────────────────────────────────

export type BountyMeta = {
  jobId:               bigint;
  poster:              Address;
  reward:              bigint;
  deadline:            bigint;
  ipfsDescHash:        string;
  category:            string;
  tags:                string[];
  agentId:             bigint;
  agentOnly:           boolean;
  assignedProvider:    Address;
  submittedResultHash: string;
  funded:              boolean;
};

export type ReputationScore = {
  averageScore:   bigint;
  totalFeedbacks: bigint;
  totalJobs:      bigint;
};

// ─── SDK-level types ──────────────────────────────────────────────────────────

export type OpenBountiesFilter = {
  category?: string;
  agentOnly?: boolean;
  maxReward?: number;        // in USDC dollars
  minReward?: number;
  offset?: number;
  limit?: number;
};

export type TakeBountyOptions = {
  /** ERC-8004 agentId to use. If omitted, uses the registered agentId. */
  agentId?: bigint;
};

export type SubmitWorkOptions = {
  /** Raw text/markdown result — will be pinned to IPFS */
  text?: string;
  /** Pre-computed IPFS CID (ipfs://...) — skips pinning */
  cid?: string;
};

export type AgentInfo = {
  agentId: bigint;
  address: Address;
  metadataURI: string;
  reputation: ReputationScore;
};

export type TxResult = {
  hash: Hash;
};
