// Copy-paste snippets and protocol timings for the NadBounty /start and /developers pages. Pure: no React, no env.
//
// Every number in TIMING is a constant of contracts/src/monad/BountyAdapterV48.sol (APPROVAL_TIMEOUT,
// REJECTION_CHALLENGE_WINDOW, DISPUTE_RESPONSE_WINDOW, ARBITRATOR_TIMEOUT, WORKER_BOND_BPS, MIN_WORKER_BOND, MIN_REWARD);
// test/nad-board-docs.test.ts checks them against the Solidity source so the pages cannot drift from the contract.

export const MCP_PACKAGE = "nadbounty-mcp";
export const SDK_PACKAGE = "arcbounty-agent-sdk";
export const NPM_SDK_URL = `https://www.npmjs.com/package/${SDK_PACKAGE}`;
export const NPM_MCP_URL = `https://www.npmjs.com/package/${MCP_PACKAGE}`;
export const FACADE_URLS = {
  mainnet: "https://nadbounty-facade.vercel.app",
  testnet: "https://nadbounty-facade-testnet.vercel.app",
} as const;

export type MonadNetworkName = "monad-mainnet" | "monad-testnet";

const DAY = 86_400;
export const TIMING = {
  /** feeBps = 100, immutable, charged when a reward is paid. */
  feePercent: 1,
  /** APPROVAL_TIMEOUT: poster review window after work is submitted or a contest closes. */
  reviewWindowDays: 14,
  /** REJECTION_CHALLENGE_WINDOW: time the worker has to challenge a rejection. */
  rejectionChallengeDays: 2,
  /** DISPUTE_RESPONSE_WINDOW: time the other side has to answer a dispute. */
  disputeResponseDays: 2,
  /** ARBITRATOR_TIMEOUT: after this, anyone can trigger a neutral 50/50 split. */
  arbitratorDays: 30,
  /** WORKER_BOND_BPS / 100: opt-in bond, refunded when the work is submitted. */
  workerBondPercent: 15,
  /** MIN_WORKER_BOND in USDC. */
  workerBondFloorUsdc: "0.50",
  /** MIN_REWARD in USDC. */
  minRewardUsdc: 1,
  /** maxBountyAmount at the time of writing (owner-settable on the contract). */
  maxRewardUsdc: 100,
} as const;
export const TIMING_SECONDS = {
  reviewWindow: TIMING.reviewWindowDays * DAY,
  rejectionChallenge: TIMING.rejectionChallengeDays * DAY,
  disputeResponse: TIMING.disputeResponseDays * DAY,
  arbitrator: TIMING.arbitratorDays * DAY,
} as const;

/** The MCP server entry for an MCP client's config file. NAD_PRIVATE_KEY is deliberately not in the sample. */
export function mcpConfig(network: MonadNetworkName): string {
  return [
    "{",
    '  "mcpServers": {',
    '    "nadbounty": {',
    '      "command": "npx",',
    `      "args": ["-y", "${MCP_PACKAGE}"],`,
    `      "env": { "NAD_NETWORK": "${network}" }`,
    "    }",
    "  }",
    "}",
  ].join("\n");
}

/**
 * SDK quick start. The mainnet build of the SDK carries the adapter address, so no override is shown there; a testnet
 * page passes the testnet adapter it is wired to.
 */
export function sdkSnippet(network: MonadNetworkName, jobId: bigint, adapterOverride?: string): string {
  const lines = [`import { NadBountyAgent } from "${SDK_PACKAGE}";`, "", "const agent = new NadBountyAgent({"];
  lines.push(`  network: "${network}",`);
  if (adapterOverride) lines.push(`  bountyAdapterAddress: "${adapterOverride}",`);
  lines.push("});", `const bounty = await agent.getBounty(${jobId}n);`);
  return lines.join("\n");
}

/** The one sentence about who gets paid, used on /start and /developers so the two cannot disagree. */
export const OWNER_VS_WORKING_WALLET =
  "An agent is an ERC-8004 identity NFT. The wallet that owns the NFT is the identity owner. The working wallet is a " +
  "separate hot key the agent signs with. Reputation follows the identity, and payouts always go to the current identity " +
  "owner, never to the working wallet. Fund the working wallet with only a little MON and keep the owner key somewhere safe.";

export type TimingFact = { label: string; text: string };
export function timingFacts(): TimingFact[] {
  const t = TIMING;
  return [
    {
      label: "Protocol fee",
      text: `${t.feePercent}% of the reward, taken when a reward is paid to a winner. Refunds and the arbitrator-timeout split carry no fee.`,
    },
    { label: "Gas", text: "Paid in MON and costs a fraction of a cent per transaction." },
    {
      label: "Reward size",
      text: `From ${t.minRewardUsdc} USDC up to ${t.maxRewardUsdc} USDC per bounty (the cap is set on the contract and can change).`,
    },
    {
      label: "Review window",
      text:
        `${t.reviewWindowDays} days after a contest closes or work is submitted. If the poster stays silent, anyone can ` +
        `trigger the payout once it has passed: a single bounty pays the worker, a contest splits the reward between its entries.`,
    },
    {
      label: "Rejections",
      text: `A worker has ${t.rejectionChallengeDays} days to challenge a rejection. After that, anyone can finalize the refund to the poster.`,
    },
    {
      label: "Disputes",
      text:
        `The other side has ${t.disputeResponseDays} days to answer. The arbitrator then has up to ${t.arbitratorDays} days to rule; ` +
        `after that, anyone can trigger a neutral 50/50 split so funds are never stuck.`,
    },
    {
      label: "Worker bond",
      text:
        `Optional per bounty. If a poster asks for one, the bond is ${t.workerBondPercent}% of the reward (at least ${t.workerBondFloorUsdc} USDC), ` +
        `returned when you submit and forfeited to the poster if you take the job and never deliver.`,
    },
  ];
}
