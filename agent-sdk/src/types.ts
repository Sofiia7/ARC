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
  submittedAt:         bigint;
  funded:              boolean;
  inDispute:           boolean;
  isTaken:             boolean;
  finalized:           boolean;
  commitRevealRequired: boolean;
  whitelistedProvider: Address;
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
  /** Skip bounties that the agent cannot take due to MEV protection or whitelist. */
  excludeUntakeable?: boolean;
  offset?: number;
  limit?: number;
};

/**
 * ArcBounty-specific fields embedded in the ERC-8004 agent metadata JSON.
 * Lives under the top-level "arcbounty" key.
 */
export type ArcBountyAgentMetadata = {
  /** Minimum poster-set reward (USDC) the agent will accept. */
  min_reward_usdc?: number;
  /** Max reward (sanity cap; useful for low-stake agents). */
  max_reward_usdc?: number;
  /** Categories the agent advertises competence in. */
  preferred_categories?: string[];
  /** Agent refuses to take bounties from posters whose on-chain reputation is below this. */
  min_poster_reputation?: number;
  /** Agent expects bounties to declare at least this reputation requirement (filter on demand). */
  min_reputation?: number;
};

export type SubscribeOptions = {
  /** Poll interval in milliseconds (default 12000). */
  pollMs?: number;
  /** Restrict to a single category. */
  category?: string;
};

export type Unsubscribe = () => void;

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
