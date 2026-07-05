// Canonical ABI for BountyAdapter V2 (humanOnly + dispute evidence).
// Mirrors contracts/src/BountyAdapter.sol and frontend/lib/contracts.ts.

const BOUNTY_META_TUPLE = {
  name: "",
  type: "tuple" as const,
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
    name: "createBounty",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{
      name: "p",
      type: "tuple",
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
    name: "takeBounty",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "jobId",   type: "uint256" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "submitWork",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "jobId",          type: "uint256" },
      { name: "ipfsResultHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "approveBounty",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "jobId",           type: "uint256" },
      { name: "reputationScore", type: "uint8"   },
    ],
    outputs: [],
  },
  {
    name: "autoApprove",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "rejectBounty",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "jobId",          type: "uint256" },
      { name: "ipfsReasonHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "challengeRejection",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "jobId",          type: "uint256" },
      { name: "ipfsReasonHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "finalizeRejection",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "cancelBounty",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "expireBounty",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "disputeBounty",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "jobId",          type: "uint256" },
      { name: "ipfsReasonHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "respondToDispute",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "jobId",            type: "uint256" },
      { name: "ipfsResponseHash", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "resolveDispute",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "jobId",             type: "uint256" },
      { name: "payProvider",       type: "bool"    },
      { name: "ipfsRulingHash",    type: "string"  },
      { name: "reputationPenalty", type: "uint8"   },
    ],
    outputs: [],
  },
  {
    name: "claimDefaultRuling",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    // V3.3 — permissionless neutral 50/50 split if the arbitrator never rules
    // after both parties have submitted evidence (claimDefaultRuling doesn't
    // apply once a response exists). See ARBITRATOR_TIMEOUT (30d).
    name: "claimArbitratorTimeout",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  // ── Read ──
  {
    // Public array getter — needed to scan the full bounty set (expireStale,
    // keeper-style scripts). Not paginated on-chain; callers should bound
    // their own scan via totalBounties().
    name: "allJobIds",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getOpenBounties",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [
      { name: "category", type: "string"  },
      { name: "offset",   type: "uint256" },
      { name: "limit",    type: "uint256" },
    ],
    outputs: [{ name: "result", type: "uint256[]" }],
  },
  {
    name: "getBountyMeta",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [BOUNTY_META_TUPLE],
  },
  {
    name: "getMyPostedBounties",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "poster", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "getMyAssignedBounties",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "provider", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "getAgentBounties",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "APPROVAL_TIMEOUT",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getAgentReputation",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{
      name: "",
      type: "tuple",
      components: [
        { name: "averageScore",   type: "uint256" },
        { name: "totalFeedbacks", type: "uint256" },
        { name: "totalJobs",      type: "uint256" },
      ],
    }],
  },
  {
    name: "totalBounties",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "arbitrator",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "DISPUTE_RESPONSE_WINDOW",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "REJECTION_CHALLENGE_WINDOW",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "ARBITRATOR_TIMEOUT",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "uniquePosterCount",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "WORKER_BOND_BPS",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "MIN_WORKER_BOND",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // ── Events ──
  {
    name: "BountyCreated",
    type: "event" as const,
    inputs: [
      { name: "jobId",    type: "uint256", indexed: true  },
      { name: "poster",   type: "address", indexed: true  },
      { name: "reward",   type: "uint256", indexed: false },
      { name: "category", type: "string",  indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
    ],
  },
  {
    name: "BountyTaken",
    type: "event" as const,
    inputs: [
      { name: "jobId",    type: "uint256", indexed: true  },
      { name: "provider", type: "address", indexed: true  },
      { name: "agentId",  type: "uint256", indexed: false },
    ],
  },
  {
    name: "WorkSubmitted",
    type: "event" as const,
    inputs: [
      { name: "jobId",          type: "uint256", indexed: true  },
      { name: "provider",       type: "address", indexed: true  },
      { name: "ipfsResultHash", type: "string",  indexed: false },
    ],
  },
  {
    name: "BountyCompleted",
    type: "event" as const,
    inputs: [
      { name: "jobId",           type: "uint256", indexed: true  },
      { name: "agentId",         type: "uint256", indexed: false },
      { name: "reputationScore", type: "uint256", indexed: false },
    ],
  },
  {
    name: "DisputeRaised",
    type: "event" as const,
    inputs: [
      { name: "jobId",      type: "uint256", indexed: true },
      { name: "initiator",  type: "address", indexed: true },
      { name: "reasonHash", type: "string",  indexed: false },
    ],
  },
  {
    name: "DisputeResponded",
    type: "event" as const,
    inputs: [
      { name: "jobId",        type: "uint256", indexed: true },
      { name: "responder",    type: "address", indexed: true },
      { name: "responseHash", type: "string",  indexed: false },
    ],
  },
  {
    name: "DisputeResolved",
    type: "event" as const,
    inputs: [
      { name: "jobId",         type: "uint256", indexed: true  },
      { name: "payProvider",   type: "bool",    indexed: false },
      { name: "rulingHash",    type: "string",  indexed: false },
      { name: "defaultRuling", type: "bool",    indexed: false },
    ],
  },
  {
    name: "ArbitratorTimeoutClaimed",
    type: "event" as const,
    inputs: [
      { name: "jobId",         type: "uint256", indexed: true  },
      { name: "posterAmount",  type: "uint256", indexed: false },
      { name: "providerAmount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "WorkerBondPosted",
    type: "event" as const,
    inputs: [
      { name: "jobId",  type: "uint256", indexed: true  },
      { name: "worker", type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "WorkerBondRefunded",
    type: "event" as const,
    inputs: [
      { name: "jobId",  type: "uint256", indexed: true  },
      { name: "worker", type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "WorkerBondForfeited",
    type: "event" as const,
    inputs: [
      { name: "jobId",  type: "uint256", indexed: true  },
      { name: "poster", type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const IDENTITY_REGISTRY_ABI = [
  {
    name: "register",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    name: "ownerOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "Transfer",
    type: "event" as const,
    inputs: [
      { name: "from",    type: "address", indexed: true },
      { name: "to",      type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    name: "approve",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [
      { name: "owner",   type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
