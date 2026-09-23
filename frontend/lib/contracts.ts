import { isAddress, type Address } from "viem";
import { getActiveNetwork } from "./networks";

const network = getActiveNetwork();

// Fail-fast: bad config must blow up at module load time, never produce a
// "successful" tx against the zero address. This module is imported by every
// page that talks to the chain, so the check runs on every build and every
// cold start.
//
// NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS overrides the adapter on testnets only,
// the same rule the SDK applies to BOUNTY_ADAPTER_ADDRESS. On a mainnet the
// baked-in address always wins: arcbounty.app's Vercel project served the
// testnet build until 2026-09-16 and still carries the testnet adapter in
// that variable, and a mainnet build reading it would aim every real-USDC
// approval and createBounty at an address with no contract on Arc mainnet.
// arc-testnet has no default, so there the variable stays exactly as
// mandatory as it always was.
function requireAdapterAddress(): Address {
  const envOverride = network.testnet ? process.env.NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS : undefined;
  const raw = envOverride ?? network.bountyAdapterAddress;
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
  AGENTIC_COMMERCE:    network.contracts.AGENTIC_COMMERCE,
  IDENTITY_REGISTRY:   network.contracts.IDENTITY_REGISTRY,
  REPUTATION_REGISTRY: network.contracts.REPUTATION_REGISTRY,
  USDC:                network.contracts.USDC,
  BOUNTY_ADAPTER:      requireAdapterAddress(),
} as const;

// Deployment block of the adapter on the active network. Anchor for chunked
// event scans - see lib/chainLogs.ts. A redeploy only moves the true deploy
// block later, so leaving this at the earliest-known deployment stays correct
// (scans a few extra empty chunks at worst).
export const BOUNTY_ADAPTER_DEPLOY_BLOCK = network.adapterDeployBlock;

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
    name: "withdrawRejection", type: "function", stateMutability: "nonpayable",
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
  {
    // M-04: V4.6 pull-payment fallback - claim USDC a failed direct payout
    // parked for the caller (see `pendingWithdrawals` below).
    name: "withdraw", type: "function", stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    // V4.7: permissionless recovery if AC's own claimRefund fired despite
    // AC_EXPIRY_BUFFER (something left unresolved for 90+ days).
    name: "reconcileExpiredEscrow", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    // V4.7: owner-only circuit breaker - blocks only createBounty/takeBounty,
    // every exit path stays open.
    name: "setPaused", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "p", type: "bool" }],
    outputs: [],
  },
  // ── Read ──
  {
    // V4.7: buffer added to a bounty's deadline for AC's own expiredAt - see
    // reconcileExpiredEscrow above. Needed by the keeper cron to know when
    // that safety net can plausibly apply to a given job.
    name: "AC_EXPIRY_BUFFER", type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
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
    // Every jobId ever created, in creation order (lib/bountyMetas.ts walks it).
    name: "allJobIds", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "feeBps", type: "function", stateMutability: "view",
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
    // V4 anti-Sybil signal - see V4_DESIGN_ANTI_SYBIL.md. Public mapping
    // getter: count of distinct posters who've paid out a completed bounty
    // to this agent. Costs N real funded wallets to fake N, unlike the raw
    // ERC-8004 average score.
    name: "uniquePosterCount", type: "function", stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // M-04: V4.6 - USDC parked for `payee` after a failed direct payout - see
    // `withdraw()`. A nonzero balance here means a settlement completed but
    // the money hasn't reached the payee's own balance yet.
    name: "pendingWithdrawals", type: "function", stateMutability: "view",
    inputs: [{ name: "payee", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // V4.7: true when new createBounty/takeBounty calls are blocked.
    name: "paused", type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
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
  // M-04: events below existed on the contract already but were missing from
  // this file (agent-sdk/src/abi.ts had already been reconciled against the
  // contract - these are copied verbatim from there).
  {
    name: "RejectionWithdrawn", type: "event",
    inputs: [{ name: "jobId", type: "uint256", indexed: true }],
  },
  {
    name: "WorkerBondPosted", type: "event",
    inputs: [
      { name: "jobId",  type: "uint256", indexed: true  },
      { name: "worker", type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "WorkerBondRefunded", type: "event",
    inputs: [
      { name: "jobId",  type: "uint256", indexed: true  },
      { name: "worker", type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "WorkerBondForfeited", type: "event",
    inputs: [
      { name: "jobId",  type: "uint256", indexed: true  },
      { name: "poster", type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    // V4.6: a direct payout failed and was credited to pendingWithdrawals
    // instead - see the `withdraw`/`pendingWithdrawals` entries above.
    name: "PayoutParked", type: "event",
    inputs: [
      { name: "jobId",  type: "uint256", indexed: true  },
      { name: "payee",  type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "WithdrawalClaimed", type: "event",
    inputs: [
      { name: "payee",  type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    // V4.7: emitted by reconcileExpiredEscrow - see its entry above.
    name: "ExternalRefundReconciled", type: "event",
    inputs: [
      { name: "jobId",        type: "uint256", indexed: true  },
      { name: "poster",       type: "address", indexed: true  },
      { name: "worker",       type: "address", indexed: true  },
      { name: "posterAmount", type: "uint256", indexed: false },
      { name: "workerAmount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "PausedSet", type: "event",
    inputs: [{ name: "paused", type: "bool", indexed: false }],
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
