// ─── Spend limits for post_bounty ───────────────────────────────────────────
//
// post_bounty moves USDC out of the configured wallet, real money on a mainnet
// network, one tool call at a time, and an agent stuck in a loop can make a lot
// of calls. Two caps bound that: the size of one reward, and the total this
// server process posts before it stops. Both default low and are raised by the
// operator in the server's environment, never by the agent through a tool.

export type SpendLimits = {
  /** Largest single reward post_bounty accepts, in USDC. */
  maxRewardUsdc: number;
  /** Most post_bounty may post in total during one run of this server, in USDC. */
  maxSpendUsdc: number;
};

export const DEFAULT_SPEND_LIMITS: SpendLimits = { maxRewardUsdc: 20, maxSpendUsdc: 50 };

/** Names of the environment variables that carry the two caps; they only appear in messages and are read from env. */
export type CapNames = { reward: string; spend: string };

/** Arc and Base servers (arcbounty-mcp, basebounty-mcp). The Monad server passes its own NAD_* names. */
export const ARC_CAP_NAMES: CapNames = { reward: 'ARCBOUNTY_MAX_REWARD_USDC', spend: 'ARCBOUNTY_MAX_SPEND_USDC' };

function readCap(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}="${raw}" is not a positive number of USDC`);
  }
  return value;
}

/** The two caps named by `names` (ARCBOUNTY_MAX_* by default); throws, naming the variable, on a value that is not a positive number. */
export function readSpendLimits(env: Record<string, string | undefined>, names: CapNames = ARC_CAP_NAMES): SpendLimits {
  return {
    maxRewardUsdc: readCap(env, names.reward, DEFAULT_SPEND_LIMITS.maxRewardUsdc),
    maxSpendUsdc: readCap(env, names.spend, DEFAULT_SPEND_LIMITS.maxSpendUsdc),
  };
}

/** USDC has 6 decimals; comparing whole micro-units keeps 30.1 + 19.9 from reading as 50.00000000000001. */
const micro = (usdc: number): number => Math.round(usdc * 1e6);

/** Why posting `rewardUsdc` after `spentUsdc` would break a cap, or null when it fits both. */
export function spendLimitError(
  rewardUsdc: number,
  spentUsdc: number,
  limits: SpendLimits,
  names: CapNames = ARC_CAP_NAMES,
): string | null {
  if (micro(rewardUsdc) > micro(limits.maxRewardUsdc)) {
    return `A ${rewardUsdc} USDC reward is above this server's per-bounty cap of ${limits.maxRewardUsdc} USDC ` +
      `(${names.reward}). Only the operator can raise it, in the server's configuration.`;
  }
  if (micro(spentUsdc) + micro(rewardUsdc) > micro(limits.maxSpendUsdc)) {
    return `This server has posted ${spentUsdc} USDC in rewards so far; ${rewardUsdc} more would pass its cap of ` +
      `${limits.maxSpendUsdc} USDC per run (${names.spend}). Only the operator can raise it or restart the server.`;
  }
  return null;
}
