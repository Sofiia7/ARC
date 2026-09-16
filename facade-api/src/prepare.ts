import {
  BOUNTY_ADAPTER_ABI,
  ERC20_ABI,
  parseUsdc,
  bondCreateDeadlineOk,
} from "./sdk.js";
import { encodeFunctionData, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import type { FacadeConfig } from "./config.js";
import { formatUsdc } from "./serialize.js";

/**
 * POST /v1/bounties/prepare - the facade is non-custodial and never relays:
 * it validates the request and returns UNSIGNED transactions the agent signs
 * with its own wallet. The x402 fee pays for validation/preparation, not for
 * the escrow itself.
 */

// M-10 (1): was anchored at the start only, so "Qm" + 44 valid chars +
// "<anything>" still passed - the regex matched a prefix of the string, not
// the whole thing. Now anchored at both ends, and the bafy… tail is bounded
// instead of open-ended.
//
// The bound matches the contract's MAX_CID_LEN (96 bytes, see
// BountyAdapter.sol) applied to what actually gets stored on-chain:
// buildPrepareResponse() below always sends "ipfs://" + <CID part> (adding
// the prefix itself when the caller omits it), so the CID part alone must
// leave room for those 7 bytes - 89 max. The Qm… form is fixed-length (46)
// and already well under that; the bafy… form's variable tail is capped at
// 85 (89 - the fixed "bafy" prefix).
const cidPattern = /^(?:ipfs:\/\/)?(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{20,85})$/;

// M-10 (4): a generous but bounded deadline horizon. Catches an obviously
// wrong timestamp client-side (e.g. milliseconds passed where seconds were
// expected overshoots this by ~1000x) instead of accepting it and letting it
// fail confusingly later (or, worse, not fail at all - the contract only
// requires deadline > block.timestamp, so a wildly-far-future value would
// otherwise sail through on-chain too).
const MAX_DEADLINE_HORIZON_SEC = 5 * 365 * 24 * 60 * 60; // ~5 years

export const prepareBountySchema = z.object({
  // M-10 (2): lower bound added - contract MIN_REWARD is a fixed 1e6 atomic
  // (1.00 USDC) constant, true for every deployment, so it's safe to check
  // here rather than only on-chain where it just reverts with "reward too
  // low" after the caller already paid the x402 fee for /prepare. The upper
  // bound here is deliberately just a static sanity ceiling, not the real
  // limit - maxBountyAmount is a live, owner-settable, per-deployment value
  // (Base mainnet defaults to 500 USDC atomic, Arc ships uncapped - see
  // contracts/script/DeployBaseMainnet.s.sol), so the actual cap is enforced
  // in validatePrepare() below via a live on-chain read, not hardcoded here.
  rewardUsdc: z
    .number()
    .positive()
    .min(1, "reward must be at least 1.00 USDC (contract MIN_REWARD)")
    .max(1_000_000, "reward exceeds the facade's static sanity ceiling - the live, network-specific cap is checked separately and may be much lower"),
  /** Unix seconds, absolute. Upper-bounded in validatePrepare() (needs
   * Date.now(), which belongs with the other now-relative deadline check). */
  deadline: z.number().int().positive(),
  /** Pre-pinned IPFS CID - the facade does not pin content for callers. */
  descriptionCid: z.string().regex(cidPattern, "expected an IPFS CID (Qm… / bafy…, optionally ipfs://-prefixed)"),
  category: z.enum(["dev", "design", "content", "data", "other"]),
  tags: z.array(z.string().min(1).max(32)).max(10).default([]),
  provider: z.string().optional(),
  agentOnly: z.boolean().default(false),
  humanOnly: z.boolean().default(false),
  requireWorkerBond: z.boolean().default(false),
  /**
   * Optional network hint. A given facade instance serves exactly one
   * network (config.network) - if the caller passes this, it must match, or
   * the request is rejected (400) rather than silently prepared for the
   * wrong chain. Omit it to just use whatever network this instance serves.
   *
   * M-10 (3): "base-mainnet" was missing here even though config.ts's own
   * SUPPORTED_NETWORKS has carried it since that file's fix for the same
   * class of drift (see the comment there) - kept in sync with it by hand,
   * since a hint enum and a config allowlist can't share one const and both
   * stay literal types.
   */
  chain: z.enum(["arc-testnet", "arc-mainnet", "base-mainnet", "base-sepolia"]).optional(),
});

export type PrepareBountyRequest = z.infer<typeof prepareBountySchema>;

/**
 * The subset of BountyReader that validatePrepare needs, structurally rather
 * than as a hard class dependency - keeps prepare.ts from importing all of
 * bounties.ts's viem/caching machinery just for one method's type.
 */
export interface PrepareChainState {
  /** Live, per-deployment createBounty reward cap, 0 = uncapped. */
  maxBountyAmount(): Promise<bigint>;
  /** V4.7: true when the owner has paused new createBounty/takeBounty calls. */
  paused(): Promise<boolean>;
}

/** @deprecated Renamed to {@link PrepareChainState} (it now covers `paused`
 *  too, not just the reward cap) - kept as an alias so any external import
 *  doesn't break. */
export type MaxBountyAmountSource = PrepareChainState;

/**
 * M-10 (2): now async - the reward ceiling check needs a live on-chain read
 * (maxBountyAmount is owner-settable and genuinely differs per network, see
 * the schema comment above), which a synchronous function can't do. Callers
 * must await this; app.ts's route handler does.
 */
export async function validatePrepare(
  req: PrepareBountyRequest,
  config: FacadeConfig,
  reader: PrepareChainState,
): Promise<string | null> {
  if (req.chain !== undefined && req.chain !== config.network) {
    return `this facade instance serves chain=${config.network} only (requested "${req.chain}")`;
  }
  if (req.agentOnly && req.humanOnly) return "agentOnly and humanOnly are mutually exclusive";
  const nowSec = Math.floor(Date.now() / 1000);
  if (req.deadline <= nowSec + 600) return "deadline must be at least 10 minutes in the future (unix seconds)";
  // M-10 (4): upper bound - see MAX_DEADLINE_HORIZON_SEC comment above.
  if (req.deadline > nowSec + MAX_DEADLINE_HORIZON_SEC) {
    return "deadline is too far in the future (max ~5 years out) - check you passed unix seconds, not milliseconds";
  }
  if (req.requireWorkerBond && !bondCreateDeadlineOk(BigInt(req.deadline), BigInt(nowSec))) {
    return "requireWorkerBond bounties need a deadline at least 24h out (contract MIN_BOND_BOUNTY_DURATION) plus a safety margin - use 25h or more";
  }
  if (req.provider !== undefined && !isAddress(req.provider)) return `provider is not a valid address: ${req.provider}`;

  // Found in review of the C-01/C-02 contract fixes: this route validated
  // maxBountyAmount live but never checked the new `paused` circuit breaker,
  // so a paused deployment could still return a "valid" createBounty tx that
  // always reverts on-chain.
  if (await reader.paused()) {
    return "this deployment is currently paused (owner circuit breaker) - createBounty is not accepted right now";
  }

  // M-10 (2): the real reward ceiling, read live rather than hardcoded - see
  // the schema comment on rewardUsdc for why a flat constant can't be right
  // across networks. 0 means uncapped (Arc's default), so only reject when a
  // cap is actually set and exceeded.
  const rewardAtomic = parseUsdc(req.rewardUsdc);
  const maxBountyAtomic = await reader.maxBountyAmount();
  if (maxBountyAtomic > 0n && rewardAtomic > maxBountyAtomic) {
    return (
      `reward exceeds this deployment's live maxBountyAmount (${formatUsdc(maxBountyAtomic)} USDC) - ` +
      `the contract would revert with "reward exceeds maxBountyAmount"`
    );
  }

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
    chainId: config.chainId,
    chain: config.network,
    // Sign and send in order. Tx 1 may be skipped if the poster's USDC
    // allowance to the adapter already covers the reward.
    transactions: [
      {
        purpose: "approve-usdc",
        to: config.usdcAddress,
        data: approveData,
        value: "0",
        description: `Approve ${formatUsdc(reward)} USDC to the BountyAdapter (${config.bountyAdapterAddress}) so it can escrow the reward. Skippable if your allowance already covers it.`,
      },
      {
        purpose: "create-bounty",
        to: config.bountyAdapterAddress,
        data: createData,
        value: "0",
        description: `Create a ${req.category} bounty paying ${formatUsdc(reward)} USDC, deadline ${new Date(req.deadline * 1000).toISOString()}${req.requireWorkerBond ? ", worker bond required" : ""}. Emits BountyCreated(jobId, …) - read your jobId from the receipt.`,
      },
    ],
    notes: [
      "The facade never sees your keys and never relays - sign and broadcast these yourself.",
      config.nativeCurrency.isUsdc
        ? `On ${config.networkName} gas is paid in USDC (the native token) - no second asset needed.`
        : `On ${config.networkName} gas is paid in ${config.nativeCurrency.symbol}, NOT in USDC: fund this ` +
          `wallet with ${config.nativeCurrency.symbol} for gas in addition to the USDC reward, or these ` +
          `transactions cannot be broadcast.`,
      "The contract enforces its own minimum reward and deadline rules on-chain; passing validation here does not guarantee acceptance if chain state changed.",
    ],
  };
}
