import {
  BOUNTY_ADAPTER_ABI,
  CONTRACTS,
  ERC20_ABI,
  ARC_TESTNET_CHAIN_ID,
  parseUsdc,
  bondCreateDeadlineOk,
} from "./sdk.js";
import { encodeFunctionData, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import type { FacadeConfig } from "./config.js";
import { formatUsdc } from "./serialize.js";

/**
 * POST /v1/bounties/prepare — the facade is non-custodial and never relays:
 * it validates the request and returns UNSIGNED transactions the agent signs
 * with its own wallet. The x402 fee pays for validation/preparation, not for
 * the escrow itself.
 */

const cidPattern = /^(ipfs:\/\/)?(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{20,})/;

export const prepareBountySchema = z.object({
  rewardUsdc: z.number().positive().max(1_000_000),
  /** Unix seconds, absolute. */
  deadline: z.number().int().positive(),
  /** Pre-pinned IPFS CID — the facade does not pin content for callers. */
  descriptionCid: z.string().regex(cidPattern, "expected an IPFS CID (Qm… / bafy…, optionally ipfs://-prefixed)"),
  category: z.enum(["dev", "design", "content", "data", "other"]),
  tags: z.array(z.string().min(1).max(32)).max(10).default([]),
  provider: z.string().optional(),
  agentOnly: z.boolean().default(false),
  humanOnly: z.boolean().default(false),
  requireWorkerBond: z.boolean().default(false),
  /** Only "arc-testnet" today; the field exists so the API shape survives multichain. */
  chain: z.literal("arc-testnet").default("arc-testnet"),
});

export type PrepareBountyRequest = z.infer<typeof prepareBountySchema>;

export function validatePrepare(req: PrepareBountyRequest): string | null {
  if (req.agentOnly && req.humanOnly) return "agentOnly and humanOnly are mutually exclusive";
  const nowSec = Math.floor(Date.now() / 1000);
  if (req.deadline <= nowSec + 600) return "deadline must be at least 10 minutes in the future (unix seconds)";
  if (req.requireWorkerBond && !bondCreateDeadlineOk(BigInt(req.deadline), BigInt(nowSec))) {
    return "requireWorkerBond bounties need a deadline at least 24h out (contract MIN_BOND_BOUNTY_DURATION) plus a safety margin — use 25h or more";
  }
  if (req.provider !== undefined && !isAddress(req.provider)) return `provider is not a valid address: ${req.provider}`;
  return null;
}

export function buildPrepareResponse(req: PrepareBountyRequest, config: FacadeConfig) {
  const reward = parseUsdc(req.rewardUsdc);
  const descCid = req.descriptionCid.startsWith("ipfs://") ? req.descriptionCid : `ipfs://${req.descriptionCid}`;

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [config.bountyAdapterAddress, reward],
  });

  const createData = encodeFunctionData({
    abi: BOUNTY_ADAPTER_ABI,
    functionName: "createBounty",
    args: [{
      provider: (req.provider as Address | undefined) ?? zeroAddress,
      reward,
      deadline: BigInt(req.deadline),
      ipfsDescHash: descCid,
      category: req.category,
      tags: req.tags,
      agentOnly: req.agentOnly,
      humanOnly: req.humanOnly,
      requireWorkerBond: req.requireWorkerBond,
    }],
  });

  return {
    chainId: ARC_TESTNET_CHAIN_ID,
    chain: req.chain,
    // Sign and send in order. Tx 1 may be skipped if the poster's USDC
    // allowance to the adapter already covers the reward.
    transactions: [
      {
        purpose: "approve-usdc",
        to: CONTRACTS.USDC,
        data: approveData,
        value: "0",
        description: `Approve ${formatUsdc(reward)} USDC to the BountyAdapter (${config.bountyAdapterAddress}) so it can escrow the reward. Skippable if your allowance already covers it.`,
      },
      {
        purpose: "create-bounty",
        to: config.bountyAdapterAddress,
        data: createData,
        value: "0",
        description: `Create a ${req.category} bounty paying ${formatUsdc(reward)} USDC, deadline ${new Date(req.deadline * 1000).toISOString()}${req.requireWorkerBond ? ", worker bond required" : ""}. Emits BountyCreated(jobId, …) — read your jobId from the receipt.`,
      },
    ],
    notes: [
      "The facade never sees your keys and never relays — sign and broadcast these yourself.",
      "On Arc Testnet gas is paid in USDC (the native token).",
      "The contract enforces its own minimum reward and deadline rules on-chain; passing validation here does not guarantee acceptance if chain state changed.",
    ],
  };
}
