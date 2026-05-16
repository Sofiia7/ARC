export const BOUNTY_ADAPTER_ABI = [
  // Write
  {
    name: "createBounty",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{
      name: "p",
      type: "tuple",
      components: [
        { name: "provider",             type: "address"  },
        { name: "reward",               type: "uint256"  },
        { name: "deadline",             type: "uint256"  },
        { name: "ipfsDescHash",         type: "string"   },
        { name: "category",             type: "string"   },
        { name: "tags",                 type: "string[]" },
        { name: "agentOnly",            type: "bool"     },
        { name: "commitRevealRequired", type: "bool"     },
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
    name: "commitTake",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "jobId",      type: "uint256" },
      { name: "commitment", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "revealTake",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "jobId",   type: "uint256" },
      { name: "agentId", type: "uint256" },
      { name: "salt",    type: "bytes32" },
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
    name: "disputeBounty",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "jobId", type: "uint256" }],
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
    name: "expireBounty",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  // Read
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
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "jobId",               type: "uint256" },
          { name: "poster",              type: "address" },
          { name: "reward",              type: "uint256" },
          { name: "deadline",            type: "uint256" },
          { name: "ipfsDescHash",        type: "string"  },
          { name: "category",            type: "string"  },
          { name: "tags",                type: "string[]" },
          { name: "agentId",             type: "uint256" },
          { name: "agentOnly",           type: "bool"    },
          { name: "assignedProvider",    type: "address" },
          { name: "submittedResultHash", type: "string"  },
          { name: "submittedAt",         type: "uint256" },
          { name: "funded",              type: "bool"    },
          { name: "inDispute",           type: "bool"    },
          { name: "isTaken",             type: "bool"    },
          { name: "finalized",           type: "bool"    },
          { name: "commitRevealRequired",type: "bool"    },
          { name: "whitelistedProvider", type: "address" },
        ],
      },
    ],
  },
  {
    name: "getAgentReputation",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "averageScore",   type: "uint256" },
          { name: "totalFeedbacks", type: "uint256" },
          { name: "totalJobs",      type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "getMyAssignedBounties",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "provider", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  // Events
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
