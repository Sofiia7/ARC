import { bondCreateDeadlineOk } from "./logic.js";
import { NAD_CATEGORIES, NAD_MIN_REWARD } from "./constants.js";
import { NadBountyError } from "./nadErrors.js";

/** The fields of the adapter's `createBounty` struct that are checked client-side. */
export type NadCreateParamsLike = {
  reward: bigint;
  deadline: bigint;
  ipfsDescHash: string;
  category: string;
  tags: readonly string[];
  agentOnly: boolean;
  humanOnly: boolean;
  requireWorkerBond: boolean;
  contest: boolean;
  maxEntries: number;
  winners: number;
  minAvgScore: number;
};

const bytes = (value: string) => new TextEncoder().encode(value).length;
const fail = (message: string): never => {
  throw new NadBountyError(`createBounty parameters: ${message}`, "INVALID_PARAMS");
};

/**
 * Mirror of what the adapter's `createBounty` enforces, run before the USDC
 * approval is sent so a mistake does not cost an approve transaction first.
 * The chain stays the authority; this only catches the common footguns:
 * a duration or milliseconds passed as `deadline`, a reward not in USDC base
 * units, and contest shapes the contract refuses.
 *
 * @param nowSec current unix time in seconds (injectable for tests).
 */
export function validateNadCreateParams(p: NadCreateParamsLike, nowSec: bigint): void {
  if (typeof p.reward !== "bigint") {
    fail("reward must be a bigint in USDC base units (6 decimals), for example 5_000_000n for 5 USDC");
  }
  if (typeof p.deadline !== "bigint") {
    fail("deadline must be a bigint: an absolute unix timestamp in seconds");
  }
  if (p.reward < NAD_MIN_REWARD) fail(`reward ${p.reward} is below the 1 USDC minimum (1000000 base units)`);
  if (p.deadline <= nowSec) {
    fail(
      `deadline ${p.deadline} is not in the future. It is an absolute unix timestamp in seconds ` +
        "(for example Math.floor(Date.now() / 1000) + 7 * 86400), not a duration",
    );
  }
  if (p.deadline > 10_000_000_000n) {
    fail(`deadline ${p.deadline} is far too large: it looks like milliseconds. Use unix seconds`);
  }
  if (!(NAD_CATEGORIES as readonly string[]).includes(p.category)) {
    fail(`category "${p.category}" is not one of ${NAD_CATEGORIES.join(", ")}`);
  }
  if (p.tags.length > 10) fail("at most 10 tags are allowed");
  for (const tag of p.tags) {
    const length = bytes(tag);
    if (length < 1 || length > 32) fail(`tag "${tag}" must be 1-32 bytes`);
  }
  const cidLength = bytes(p.ipfsDescHash);
  if (cidLength < 1 || cidLength > 96) fail("ipfsDescHash must be an IPFS URI or CID of 1-96 bytes");
  if (p.agentOnly && p.humanOnly) fail("agentOnly and humanOnly cannot both be true");
  if (!Number.isInteger(p.minAvgScore) || p.minAvgScore < 0 || p.minAvgScore > 100) {
    fail("minAvgScore must be an integer from 0 to 100");
  }
  if (p.contest) {
    if (p.requireWorkerBond) fail("a contest cannot require a worker bond");
    if (!Number.isInteger(p.maxEntries) || p.maxEntries < 1 || p.maxEntries > 25) {
      fail("a contest needs maxEntries from 1 to 25");
    }
    if (!Number.isInteger(p.winners) || p.winners < 1 || p.winners > p.maxEntries) {
      fail("a contest needs winners from 1 to maxEntries");
    }
  } else if (p.requireWorkerBond && !bondCreateDeadlineOk(p.deadline, nowSec)) {
    fail("a bond bounty needs a deadline at least 24 hours (plus a 15 minute safety margin) ahead");
  }
}
