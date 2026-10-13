import { formatUnits } from "viem";

/**
 * A failed NadBounty call, translated from a raw viem error blob. `code` is the
 * adapter's custom error name (for example "ReputationGateFailed"), the revert
 * string (for example "paused"), or one of "INSUFFICIENT_FUNDS", "NETWORK",
 * "UNRECOGNIZED_REVERT", "UNKNOWN". The message never contains the RPC URL and
 * the original error is deliberately not attached as `cause`, because its text
 * does include it.
 */
export class NadBountyError extends Error {
  readonly code: string;
  readonly args: readonly unknown[];
  constructor(message: string, code: string, args: readonly unknown[] = []) {
    super(message);
    this.name = "NadBountyError";
    this.code = code;
    this.args = args;
  }
}

/** Replace every http(s) URL (an RPC endpoint can carry an API key in its path). */
export function redactUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>)\]]*[^\s"'<>)\].,;:!?]/gi, "[url]");
}

const usdc = (value: unknown): string => {
  try {
    return `${formatUnits(BigInt(value as bigint), 6)} USDC`;
  } catch {
    return String(value);
  }
};

const CUSTOM_ERRORS: Record<string, (args: readonly unknown[]) => string> = {
  ReputationGateFailed: ([paidJobs, scoreSum]) => {
    const jobs = BigInt((paidJobs as bigint) ?? 0n);
    const sum = BigInt((scoreSum as bigint) ?? 0n);
    const average = jobs > 0n ? `${Number((sum * 100n) / jobs) / 100}` : "n/a";
    return (
      `Reputation gate not met: this identity has ${jobs} paid job(s) with a score sum of ${sum} ` +
      `(average ${average}). The bounty requires more paid jobs or a higher average score ` +
      "(minJobs / minAvgScore). Check getIdentityReputation() against the bounty's gate."
    );
  },
  InvalidGateScore: () => "minAvgScore must be between 0 and 100.",
  InvalidIdentity: () =>
    "Invalid ERC-8004 identity: this agentId does not exist or has no owner, " +
    "or agentId 0 (a human) was used without a wallet address.",
  WrongBountyMode: () =>
    "This action does not apply to this kind of bounty. Single-taker bounties and contests use different functions " +
    "(takeBounty/submitWork versus enterContest/pickContestWinners).",
  InvalidContestParams: () =>
    "Invalid contest parameters: a contest needs 1-25 entries, between 1 and maxEntries winners, " +
    "and cannot require a worker bond.",
  UnexpectedEscrowAmount: ([received, expected]) =>
    `The escrow released ${usdc(received)} but ${usdc(expected)} was expected, ` +
    "so the transaction was refused to protect pooled funds.",
  ReentrancyGuardReentrantCall: () => "The adapter blocked a reentrant call. Do not call it from inside a callback.",
  SafeERC20FailedOperation: ([token]) =>
    `A USDC transfer failed (token ${String(token)}). Check the USDC balance and the allowance for the adapter, ` +
    "and that no address involved is blocklisted.",
  ERC721NonexistentToken: ([tokenId]) => `Identity agentId ${String(tokenId)} does not exist on the ERC-8004 registry.`,
};

const REVERT_STRINGS: Record<string, string> = {
  paused:
    "NadBounty is paused: creating bounties, taking bounties and entering contests are switched off. " +
    "Settlements, refunds and withdrawals still work.",
  "reward too low": "The reward is below the 1 USDC minimum (1000000 base units).",
  "reward exceeds maxBountyAmount":
    "The reward is above the per-bounty cap set by the owner (100 USDC at launch; read it with maxBountyAmount()).",
  "deadline in past":
    "The deadline is not in the future. It must be an absolute unix timestamp in seconds, not a duration.",
  "bond bounty: deadline too soon": "A bounty with a worker bond needs a deadline at least 24 hours away.",
  "bond bounty: too close to deadline": "Less than 12 hours remain, so this bond bounty can no longer be taken.",
  "invalid category": "The category must be one of dev, design, content, data or other.",
  "agentOnly+humanOnly": "A bounty cannot be both agentOnly and humanOnly.",
  "too many tags": "At most 10 tags are allowed.",
  "tag bad len": "Each tag must be between 1 and 32 bytes.",
  "insufficient USDC allowance":
    "The USDC allowance for the adapter is below the reward. Approve the amount first (the SDK does this automatically).",
  "bounty not found": "No bounty exists with this jobId.",
  "already taken": "This bounty has already been taken.",
  "already taken, cannot cancel": "A taken bounty cannot be cancelled by the poster.",
  resolved: "This bounty is already settled.",
  "bounty expired": "The deadline has passed.",
  "not expired yet": "The deadline has not passed yet, so this cannot be expired.",
  "agent only: provide agentId": "This bounty is agent-only: pass your ERC-8004 agentId (not 0).",
  "human only: no agentId": "This bounty is human-only: pass agentId 0.",
  "agent only: caller is not agent owner":
    "The caller is neither the owner nor the current working wallet of this agentId.",
  "not whitelisted": "This bounty is reserved for a specific provider and the caller is not that provider.",
  "not assigned provider": "Only the worker who took this bounty can do this.",
  "only worker": "Only the worker who took this bounty can do this.",
  "only poster": "Only the poster of this bounty can do this.",
  "only arbitrator": "Only the arbitrator (the Safe) can do this.",
  "only owner": "Only the adapter owner can do this.",
  "only fee recipient": "Only the fee recipient can do this.",
  "only identity owner": "Only the current owner of the ERC-8004 identity can do this (a working wallet cannot).",
  unauthorized: "The caller is neither the poster nor the worker of this bounty.",
  "not pending": "The caller is not the pending address for this role.",
  "already submitted": "Work was already submitted for this bounty.",
  "no submission": "Nothing has been submitted for this bounty yet.",
  "has submission": "A submission exists, so the bounty cannot be expired.",
  "in dispute": "This bounty is in dispute.",
  "not in dispute": "This bounty is not in dispute.",
  "already in dispute": "This bounty is already in dispute.",
  "rejection pending":
    "The poster's rejection is pending, so it cannot be approved until it is withdrawn or finalized.",
  "already rejected": "This submission was already rejected.",
  "no pending rejection": "There is no pending rejection on this bounty.",
  "already challenged": "This was already challenged.",
  "use challengeRejection": "A rejection is pending: the worker must use challengeRejection instead.",
  "use claimDefaultRuling":
    "The respondent answered, so claimDefaultRuling does not apply; use claimArbitratorTimeout.",
  "approval window open": "The 14-day approval window has not ended yet, so autoApprove is not available.",
  "approval window elapsed, use autoApprove": "The 14-day approval window has ended: use autoApprove.",
  "challenge window open": "The 48-hour challenge window is still open.",
  "challenge window closed": "The 48-hour challenge window has closed.",
  "challenge window active": "The 48-hour challenge window is still running.",
  "response window closed": "The 48-hour response window has closed.",
  "window still open": "The 48-hour response window is still open.",
  "respondent replied": "The other side already replied, so a default ruling is not available.",
  "already responded": "This was already answered.",
  "not the respondent": "Only the other party of the dispute can respond to it.",
  "arbitrator window open": "The 30-day arbitrator window is still open.",
  "arbitrator window active": "The 30-day arbitrator window is still open.",
  "arbitrator window ended": "The 30-day arbitrator window has ended.",
  "AC job not expired": "The escrow job has not expired, so there is nothing to reconcile.",
  "penalty>100": "The reputation penalty must be between 0 and 100.",
  "score>100": "The score must be between 0 and 100.",
  "score > 100": "Every score must be between 0 and 100.",
  "nothing to withdraw": "There is nothing to withdraw for this address or identity.",
  "contest closed": "The contest no longer accepts entries.",
  "contest full": "The contest already has its maximum number of entries.",
  "already entered": "This identity already has an entry in this contest.",
  "not entrant": "Only the wallet that made this entry can do this.",
  "invalid entry": "That entry index does not exist.",
  "duplicate winner": "A winner index was listed twice.",
  "invalid winner count": "Pick between 1 and the contest's number of winners.",
  "invalid scores": "Pass exactly one score per selected entry.",
  "contest rejected": "All entries were already rejected by the poster.",
  "contest not rejected": "The poster has not rejected the entries.",
  "contest still open": "The contest is still open for entries.",
  "no entries": "The contest has no entries.",
  "has entries": "The contest already has entries.",
  "review ended": "The 14-day review window has ended.",
  "review active": "The 14-day review window is still running.",
  "no challenges": "Nobody has challenged this contest's rejection.",
  "has challenges": "The rejection was challenged, so it cannot simply be finalized.",
  "unanswered challenge": "A challenge has not been answered yet.",
  "no overdue challenge": "No challenge has passed its 48-hour response deadline.",
  "not challenger": "That entry did not challenge the rejection.",
  // ERC-8004 identity registry
  expired: "The wallet consent has expired. Sign a new one and submit it within 5 minutes.",
  "deadline too far": "The wallet consent deadline is more than 5 minutes ahead. Sign one with a shorter deadline.",
  "invalid wallet sig":
    "The wallet signature is invalid. The NEW working wallet must sign the AgentWalletSet consent for this exact " +
    "agentId, owner and deadline.",
  "bad wallet": "The working wallet address is not valid (it cannot be the zero address).",
  "Not authorized": "Not authorized: only the identity owner (or an approved operator) can do this.",
};

type ErrLike = { name?: string; shortMessage?: string; message?: string; cause?: unknown };

function findByName(error: unknown, name: string): Record<string, unknown> | null {
  let current: unknown = error;
  for (let depth = 0; depth < 12 && current && typeof current === "object"; depth++) {
    if ((current as ErrLike).name === name) return current as Record<string, unknown>;
    current = (current as ErrLike).cause;
  }
  return null;
}

function revertStringMessage(reason: string): string {
  const known = REVERT_STRINGS[reason];
  if (known) return known;
  const empty = /^empty (.+)$/.exec(reason);
  if (empty) return `${empty[1]} is empty: pass a non-empty IPFS CID or URI.`;
  const tooLong = /^(.+) too long$/.exec(reason);
  if (tooLong) return `${tooLong[1]} is too long: IPFS references are limited to 96 bytes.`;
  return `The contract rejected the call: ${redactUrls(reason).slice(0, 200)}`;
}

function describeRevert(revert: Record<string, unknown>): { code: string; args: readonly unknown[]; message: string } {
  const data = revert["data"] as { errorName?: string; args?: readonly unknown[] } | undefined;
  const errorName = data?.errorName;
  const args = data?.args ?? [];
  if (errorName === "Error") {
    const reason = String(args[0] ?? revert["reason"] ?? "");
    return { code: reason, args, message: revertStringMessage(reason) };
  }
  if (errorName === "Panic") {
    return {
      code: "Panic",
      args,
      message: `The contract hit an internal panic (code ${String(args[0])}). This is a contract bug or an unsupported state.`,
    };
  }
  if (errorName && CUSTOM_ERRORS[errorName]) {
    return { code: errorName, args, message: CUSTOM_ERRORS[errorName]!(args) };
  }
  if (errorName) return { code: errorName, args, message: `The contract rejected the call with ${errorName}.` };
  const reason = revert["reason"];
  if (typeof reason === "string" && reason) return { code: reason, args: [], message: revertStringMessage(reason) };
  const signature = typeof revert["signature"] === "string" ? (revert["signature"] as string) : undefined;
  return {
    code: "UNRECOGNIZED_REVERT",
    args: [],
    message:
      "The call reverted with an error this SDK does not recognize" +
      (signature ? ` (selector ${signature})` : "") +
      ". It usually comes from the escrow or the identity registry.",
  };
}

/**
 * Turn whatever viem threw into a readable {@link NadBountyError}. Errors that
 * are not viem errors and carry no URL are returned unchanged, so messages the
 * SDK itself wrote ("Wrong Monad RPC chain") stay as they are.
 *
 * @param context the SDK method that was running, for example "takeBounty".
 */
export function toNadError(error: unknown, context?: string): Error {
  if (error instanceof NadBountyError) return error;
  const prefix = context ? `${context}: ` : "";

  const revert = findByName(error, "ContractFunctionRevertedError");
  if (revert) {
    const { code, args, message } = describeRevert(revert);
    return new NadBountyError(`${prefix}${message}`, code, args);
  }
  if (findByName(error, "InsufficientFundsError") || /insufficient funds/i.test(String((error as ErrLike)?.message))) {
    return new NadBountyError(
      `${prefix}Not enough MON in the wallet to pay for gas. Monad charges for the gas limit, so keep a margin.`,
      "INSUFFICIENT_FUNDS",
    );
  }
  const execution = findByName(error, "ExecutionRevertedError");
  if (execution) {
    return new NadBountyError(
      `${prefix}The call reverted${execution["details"] ? `: ${redactUrls(String(execution["details"])).slice(0, 200)}` : "."}`,
      "UNRECOGNIZED_REVERT",
    );
  }
  for (const name of ["HttpRequestError", "TimeoutError", "RpcRequestError", "RpcError", "WebSocketRequestError"]) {
    if (findByName(error, name)) {
      return new NadBountyError(
        `${prefix}The Monad RPC request failed (network error, rate limit or timeout). Retry, or pass a different rpcUrl.`,
        "NETWORK",
      );
    }
  }

  const e = error as ErrLike | undefined;
  const raw = typeof e?.shortMessage === "string" ? e.shortMessage : typeof e?.message === "string" ? e.message : "";
  if (error instanceof Error) {
    // A viem error (it has a shortMessage) is rewritten; a plain SDK error is kept as is unless it holds a URL.
    const redacted = redactUrls(raw);
    if (typeof e?.shortMessage !== "string" && redacted === raw) return error;
    return new NadBountyError(`${prefix}${redacted.split("\n")[0]!.slice(0, 300)}`, "UNKNOWN");
  }
  return new NadBountyError(`${prefix}${redactUrls(String(error)).slice(0, 300)}`, "UNKNOWN");
}
