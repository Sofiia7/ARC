import { type Address } from "viem";

export const CONTRACTS = {
  AGENTIC_COMMERCE:    "0x0747EEf0706327138c69792bF28Cd525089e4583" as Address,
  IDENTITY_REGISTRY:   "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
  USDC:                "0x3600000000000000000000000000000000000000" as Address,
  BOUNTY_ADAPTER:      (process.env.NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address,
} as const;

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
    { name: "isTaken",              type: "bool"    },
    { name: "inDispute",            type: "bool"    },
    { name: "resolved",             type: "bool"    },
    { name: "disputeInitiator",     type: "address" },
    { name: "disputeRaisedAt",      type: "uint256" },
    { name: "disputeReasonHash",    type: "string"  },
    { name: "disputeResponseHash",  type: "string"  },
    { name: "disputeRulingHash",    type: "string"  },
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
    name: "rejectBounty", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",  type: "uint256" },
      { name: "reason", type: "string"  },
    ],
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

export const CATEGORIES = ["dev", "design", "content", "data", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
