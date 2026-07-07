import { isAddress, type Address } from "viem";

// Fail-fast: bad config must blow up at module load time, never produce a
// "successful" tx against the zero address. This module is imported by every
// page that talks to the chain, so the check runs on every build and every
// cold start.
function requireAdapterAddress(): Address {
  const raw = process.env.NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS;
  if (!raw) {
    throw new Error(
      "[arcbounty] NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS is not set. " +
      "See frontend/.env.example. Source of truth: contracts/DEPLOYMENTS.md.",
    );
  }
  if (!isAddress(raw)) {
    throw new Error(`[arcbounty] NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS is not a valid address: ${raw}`);
  }
  if (raw.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    throw new Error("[arcbounty] NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS is the zero address.");
  }
  return raw as Address;
}

export const CONTRACTS = {
  AGENTIC_COMMERCE:    "0x0747EEf0706327138c69792bF28Cd525089e4583" as Address,
  IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
  USDC:                "0x3600000000000000000000000000000000000000" as Address,
  BOUNTY_ADAPTER:      requireAdapterAddress(),
} as const;

// Deployment block of the V4.1 adapter (creation tx 0x1d2b2698…3b83c). Anchor
// for chunked event scans — see lib/chainLogs.ts. A redeploy only moves the
// true deploy block later, so leaving this at the earliest-known deployment
// stays correct (scans a few extra empty chunks at worst).
export const BOUNTY_ADAPTER_DEPLOY_BLOCK = 50_610_373n;

const BOUNTY_META_TUPLE = {
  name: "", type: "tuple",
  components: [
    { name: "jobId",                type: "uint256" },
    { name: "poster",               type: "address" },
    { name: "reward",               type: "uint256" },
    { name: "deadline",             type: "uint256" },
    { name: "ipfsDescHash",         type: "string"  },
    { name: "category",             type: "string"  },
    { name: "tags",                 type: "string[]" },
    { name: "agentId",              type: "uint256" },
    { name: "agentOnly",            type: "bool"    },
    { name: "humanOnly",            type: "bool"    },
    { name: "whitelistedProvider",  type: "address" },
    { name: "assignedProvider",     type: "address" },
    { name: "submittedResultHash",  type: "string"  },
    { name: "submittedAt",          type: "uint256" },
    { name: "isTaken",              type: "bool"    },
    { name: "rejectedAt",           type: "uint256" },
    { name: "rejectionReasonHash",  type: "string"  },
    { name: "inDispute",            type: "bool"    },
    { name: "resolved",             type: "bool"    },
    { name: "disputeInitiator",     type: "address" },
    { name: "disputeRaisedAt",      type: "uint256" },
    { name: "disputeReasonHash",    type: "string"  },
    { name: "disputeResponseHash",  type: "string"  },
    { name: "disputeRulingHash",    type: "string"  },
    { name: "requireWorkerBond",    type: "bool"    },
    { name: "workerBond",           type: "uint256" },
  ],
} as const;

export const BOUNTY_ADAPTER_ABI = [
  // ── Write ──
  {
    name: "createBounty", type: "function", stateMutability: "nonpayable",
    inputs: [{
      name: "p", type: "tuple",
      components: [
        { name: "provider",     type: "address"  },
        { name: "reward",       type: "uint256"  },
        { name: "deadline",     type: "uint256"  },
        { name: "ipfsDescHash", type: "string"   },
        { name: "category",     type: "string"   },
        { name: "tags",         type: "string[]" },
        { name: "agentOnly",    type: "bool"     },
        { name: "humanOnly",    type: "bool"     },
        { name: "requireWorkerBond", type: "bool" },
      ],
    }],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    name: "takeBounty", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",   type: "uint256" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "submitWork", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",          type: "uint256" },
      { name: "ipfsResultHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "approveBounty", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",           type: "uint256" },
      { name: "reputationScore", type: "uint8"   },
    ],
    outputs: [],
  },
  {
    name: "autoApprove", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "rejectBounty", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",          type: "uint256" },
      { name: "ipfsReasonHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "challengeRejection", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",          type: "uint256" },
      { name: "ipfsReasonHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "finalizeRejection", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "cancelBounty", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "expireBounty", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "disputeBounty", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",          type: "uint256" },
      { name: "ipfsReasonHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "respondToDispute", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",            type: "uint256" },
      { name: "ipfsResponseHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "resolveDispute", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",             type: "uint256" },
      { name: "payProvider",       type: "bool"    },
      { name: "ipfsRulingHash",    type: "string"  },
      { name: "reputationPenalty", type: "uint8"   },
    ],
    outputs: [],
  },
  {
    name: "claimDefaultRuling", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "claimArbitratorTimeout", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  // ── Read ──
  {
    name: "getOpenBounties", type: "function", stateMutability: "view",
    inputs: [
      { name: "category", type: "string"  },
      { name: "offset",   type: "uint256" },
      { name: "limit",    type: "uint256" },
    ],
    outputs: [{ name: "result", type: "uint256[]" }],
  },
  {
    name: "getBountyMeta", type: "function", stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [BOUNTY_META_TUPLE],
  },
  {
    name: "getMyPostedBounties", type: "function", stateMutability: "view",
    inputs: [{ name: "poster", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "getMyAssignedBounties", type: "function", stateMutability: "view",
    inputs: [{ name: "provider", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "getAgentBounties", type: "function", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "APPROVAL_TIMEOUT", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getAgentReputation", type: "function", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "averageScore",   type: "uint256" },
        { name: "totalFeedbacks", type: "uint256" },
        { name: "totalJobs",      type: "uint256" },
      ],
    }],
  },
  {
    name: "totalBounties", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "arbitrator", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "address" }],
  },
  {
    name: "DISPUTE_RESPONSE_WINDOW", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "REJECTION_CHALLENGE_WINDOW", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "ARBITRATOR_TIMEOUT", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    // V4 anti-Sybil signal — see V4_DESIGN_ANTI_SYBIL.md. Public mapping
    // getter: count of distinct posters who've paid out a completed bounty
    // to this agent. Costs N real funded wallets to fake N, unlike the raw
    // ERC-8004 average score.
    name: "uniquePosterCount", type: "function", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // ── Events ──
  {
    name: "BountyCreated", type: "event",
    inputs: [
      { name: "jobId",    type: "uint256", indexed: true  },
      { name: "poster",   type: "address", indexed: true  },
      { name: "reward",   type: "uint256", indexed: false },
      { name: "category", type: "string",  indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
    ],
  },
  {
    name: "BountyTaken", type: "event",
    inputs: [
      { name: "jobId",    type: "uint256", indexed: true  },
      { name: "provider", type: "address", indexed: true  },
      { name: "agentId",  type: "uint256", indexed: false },
    ],
  },
  {
    name: "WorkSubmitted", type: "event",
    inputs: [
      { name: "jobId",          type: "uint256", indexed: true  },
      { name: "provider",       type: "address", indexed: true  },
      { name: "ipfsResultHash", type: "string",  indexed: false },
    ],
  },
  {
    name: "BountyCompleted", type: "event",
    inputs: [
      { name: "jobId",           type: "uint256", indexed: true  },
      { name: "agentId",         type: "uint256", indexed: false },
      { name: "reputationScore", type: "uint256", indexed: false },
    ],
  },
  {
    name: "ProtocolFeePaid", type: "event",
    inputs: [
      { name: "jobId",     type: "uint256", indexed: true  },
      { name: "recipient", type: "address", indexed: true  },
      { name: "amount",    type: "uint256", indexed: false },
    ],
  },
  {
    name: "DisputeRaised", type: "event",
    inputs: [
      { name: "jobId",      type: "uint256", indexed: true },
      { name: "initiator",  type: "address", indexed: true },
      { name: "reasonHash", type: "string",  indexed: false },
    ],
  },
  {
    name: "DisputeResponded", type: "event",
    inputs: [
      { name: "jobId",        type: "uint256", indexed: true },
      { name: "responder",    type: "address", indexed: true },
      { name: "responseHash", type: "string",  indexed: false },
    ],
  },
  {
    name: "DisputeResolved", type: "event",
    inputs: [
      { name: "jobId",         type: "uint256", indexed: true  },
      { name: "payProvider",   type: "bool",    indexed: false },
      { name: "rulingHash",    type: "string",  indexed: false },
      { name: "defaultRuling", type: "bool",    indexed: false },
    ],
  },
  {
    name: "BountyAutoApproved", type: "event",
    inputs: [
      { name: "jobId",    type: "uint256", indexed: true },
      { name: "provider", type: "address", indexed: true },
    ],
  },
  {
    name: "BountyCancelled", type: "event",
    inputs: [
      { name: "jobId",  type: "uint256", indexed: true },
      { name: "reason", type: "string",  indexed: false },
    ],
  },
  {
    name: "BountyExpired", type: "event",
    inputs: [{ name: "jobId", type: "uint256", indexed: true }],
  },
  {
    name: "RejectionProposed", type: "event",
    inputs: [
      { name: "jobId",      type: "uint256", indexed: true },
      { name: "poster",     type: "address", indexed: true },
      { name: "reasonHash", type: "string",  indexed: false },
    ],
  },
  {
    name: "RejectionFinalized", type: "event",
    inputs: [{ name: "jobId", type: "uint256", indexed: true }],
  },
  {
    name: "RejectionChallenged", type: "event",
    inputs: [
      { name: "jobId",      type: "uint256", indexed: true },
      { name: "worker",     type: "address", indexed: true },
      { name: "reasonHash", type: "string",  indexed: false },
    ],
  },
  {
    name: "ArbitratorTimeoutClaimed", type: "event",
    inputs: [
      { name: "jobId",         type: "uint256", indexed: true  },
      { name: "posterAmount",  type: "uint256", indexed: false },
      { name: "providerAmount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance", type: "function", stateMutability: "view",
    inputs: [
      { name: "owner",   type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const IDENTITY_REGISTRY_ABI = [
  {
    name: "register", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    name: "ownerOf", type: "function", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "isRegistered", type: "function", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "Transfer", type: "event",
    inputs: [
      { name: "from",    type: "address", indexed: true },
      { name: "to",      type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

export const CATEGORIES = ["dev", "design", "content", "data", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
