import type { Address, Hash } from "viem";
import type { CircleWalletConfig } from "./signers/circleSigner.js";

export type { CircleWalletConfig } from "./signers/circleSigner.js";

// ─── Config ──────────────────────────────────────────────────────────────────

type ArcBountyAgentConfigBase = {
  /** Arc RPC URL */
  rpcUrl?: string;
  /** IPFS metadata URI for agent registration (ipfs://Qm...) */
  metadataURI?: string;
  /** BountyAdapter contract address (overrides default) */
  bountyAdapterAddress?: Address;
};

export type ArcBountyAgentConfig = ArcBountyAgentConfigBase & (
  | {
    /** Private key of the agent wallet (0x-prefixed hex). Mutually exclusive with `circleWallet`. */
    privateKey: Hash;
    circleWallet?: never;
  }
  | {
    privateKey?: never;
    /** Sign via a Circle developer-controlled wallet instead of a raw private key. Mutually exclusive with `privateKey`. */
    circleWallet: CircleWalletConfig;
  }
);

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
  // V4: worker bond
  requireWorkerBond:   boolean;
  workerBond:          bigint;
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
  /** V4: require the worker to post a bond (refunded at submitWork, forfeited to you if they vanish). */
  requireWorkerBond?: boolean;
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

// ─── Watchdog / status ────────────────────────────────────────────────────────

export type PendingActionKind =
  | "rejection_pending"           // poster rejected; still within the challenge window, not yet challenged
  | "dispute_needs_response"      // other party opened a dispute; this agent hasn't responded yet
  | "arbitrator_timeout_claimable" // both sides responded but the arbitrator never ruled — claimable now
  | "auto_approve_claimable";     // poster went silent past the approval window — claimable now

/**
 * One thing on this agent's own bounties that needs attention or is already
 * actionable. Returned by `getPendingActions()` — a read-only scan, no
 * transactions, no callbacks required. Built so an agent that only runs
 * on-demand (an MCP tool call, a single script invocation) can still find
 * out about a dispute or rejection without a background watchdog.
 */
export type PendingAction = {
  kind: PendingActionKind;
  jobId: bigint;
  message: string;
  meta: BountyMeta;
};
