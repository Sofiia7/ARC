import { decodeErrorResult, formatUnits, parseAbi, type Hex } from "viem";
import { getActiveNetwork } from "./networks";

// Turns whatever a wallet / viem / wagmi / the RPC threw into one short sentence
// a person can act on. Everything here is duck-typed on purpose: viem wraps the
// real cause two or three levels deep (ContractFunctionExecutionError ->
// ContractFunctionRevertedError -> RpcRequestError), tests feed plain objects,
// and wallets throw all sorts of shapes.
//
// Hard rules for the text this module returns: never an RPC URL, never an API
// key, never full call data. Anything free-form goes through sanitizeDetail().

export type TxErrorKind = "rejected" | "revert" | "gas" | "usdc" | "wallet" | "network" | "passkey" | "unknown";

export type TxErrorInfo = {
  /** The sentence to show. */
  message: string;
  /** False when nothing in the error was recognised (callers may then prefer their own label). */
  known: boolean;
  kind: TxErrorKind;
};

export type TxErrorContext = {
  /** Short verb phrase used only by the generic fallback, e.g. "enter the contest". */
  action?: string;
  /** Native gas token of the active chain. Defaults to the active network's symbol. */
  nativeSymbol?: string;
};

// ─── Custom errors ───────────────────────────────────────────────────────────
//
// Only the error fragments of the V4.8 adapter ABI (lib/abi-v48.ts) plus the two
// OpenZeppelin ERC-20 errors USDC-style tokens raise. They are inlined instead of
// importing BOUNTY_ADAPTER_V48_ABI because that 60 KB array would otherwise land
// in every Arc/Base page via hooks/useTx. test/nad-tx-errors.test.ts fails if the
// real ABI ever gains or changes an error that is not covered here.
const ERRORS_ABI = parseAbi([
  "error InvalidContestParams()",
  "error InvalidGateScore()",
  "error InvalidIdentity()",
  "error ReentrancyGuardReentrantCall()",
  "error ReputationGateFailed(uint256 paidJobs, uint256 scoreSum)",
  "error SafeERC20FailedOperation(address token)",
  "error UnexpectedEscrowAmount(uint256 received, uint256 expected)",
  "error WrongBountyMode()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);

/** USDC has 6 decimals: "5.00", "0.25", "1,250.50". */
export function formatUsdc(amount: bigint): string {
  const [whole, fraction = ""] = formatUnits(amount, 6).split(".");
  const cents = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

function big(value: unknown): bigint | undefined {
  return typeof value === "bigint" ? value : undefined;
}

const CUSTOM_ERRORS: Record<string, (args: readonly unknown[]) => string> = {
  ReputationGateFailed: (args) => {
    const jobs = big(args[0]);
    const sum = big(args[1]);
    if (jobs === undefined || sum === undefined) return "This bounty requires more reputation than this identity has.";
    return `This bounty requires more reputation than this identity has (${jobs} paid ${jobs === 1n ? "job" : "jobs"}, score sum ${sum}).`;
  },
  InvalidGateScore: () => "The minimum average score must be between 0 and 100.",
  InvalidIdentity: () => "That agent ID does not exist on the identity registry. Check the number and try again.",
  InvalidContestParams: () =>
    "These contest settings are not allowed: use 1-25 entries, 1 or more winners (at most the number of entries) and no worker bond.",
  WrongBountyMode: () => "This action is not available for this type of bounty (single worker versus contest).",
  UnexpectedEscrowAmount: (args) => {
    const received = big(args[0]);
    const expected = big(args[1]);
    if (received === undefined || expected === undefined) {
      return "The escrow received a different USDC amount than expected, so the transaction was stopped. Nothing was moved.";
    }
    return `The escrow received ${formatUsdc(received)} USDC instead of ${formatUsdc(expected)} USDC, so the transaction was stopped. Nothing was moved.`;
  },
  SafeERC20FailedOperation: () => "A USDC transfer failed. Check your USDC balance and approval, then try again.",
  ReentrancyGuardReentrantCall: () =>
    "The contract was called again while it was still busy. Wait for your last transaction to finish, then retry.",
  ERC20InsufficientBalance: (args) => {
    const balance = big(args[1]);
    const needed = big(args[2]);
    if (balance === undefined || needed === undefined) return "You do not have enough USDC in this wallet.";
    return `You do not have enough USDC in this wallet (balance ${formatUsdc(balance)}, needed ${formatUsdc(needed)}).`;
  },
  ERC20InsufficientAllowance: () => "The USDC approval is too low for this amount. Approve it first, then try again.",
};

/** Names of every custom error this module can explain (the test checks them against the real ABI). */
export const KNOWN_CUSTOM_ERRORS: readonly string[] = Object.keys(CUSTOM_ERRORS);

// ─── Plain revert strings ────────────────────────────────────────────────────
//
// Derived from every require(..., "...") in contracts/src/monad/BountyAdapterV48.sol.
// Keys are lower-case; lookups lower-case the reason first. Constructor-only
// messages (ac=0, id=0, rep=0, usdc=0, fee=0, mirror=0) are deliberately absent:
// no user transaction can reach them.
const PAUSED = "New activity is paused right now. Existing payouts and refunds still work.";
const NOT_POSTER = "Only the wallet that posted this bounty can do that.";
const NOT_ARBITRATOR = "Only the arbitrator can do that.";
const BAD_SCORE = "Scores must be between 0 and 100.";
const SETTLED = "This bounty is already settled.";
const NO_SUCH_ENTRY = "That contest entry does not exist.";
const IN_DISPUTE = "This bounty is in dispute.";
const IN_DISPUTE_ALREADY = "This bounty is already in dispute.";
const CHALLENGE_OPEN = "The 48 hour challenge window is still open. Wait until it ends.";
const CHALLENGE_CLOSED = "The 48 hour challenge window has closed.";
const ARBITRATOR_STILL = "The arbitrator still has time to rule.";
const NOT_YET_RESPONDED = "Some challenges are still waiting for the poster's response.";
const RESPONSE_CLOSED = "The response window has closed.";
const NOT_FOUND = "That bounty does not exist.";
const AGENT_OWNER = "This wallet does not own that agent ID (or its working wallet). Connect the wallet that does.";
const ADMIN_ONLY = "Only the protocol admin can do that.";

export const REVERT_MESSAGES: Readonly<Record<string, string>> = {
  // Posting
  paused: PAUSED,
  "reward too low": "The reward is below the 1 USDC minimum.",
  "reward exceeds maxbountyamount": "The reward is above the current per-bounty limit.",
  "deadline in past": "The deadline must be in the future.",
  "bond bounty: deadline too soon": "A bounty with a worker bond needs a deadline at least 24 hours away.",
  "invalid category": "Choose one of the listed categories.",
  "agentonly+humanonly": "A bounty cannot be both agent-only and human-only.",
  "too many tags": "Use at most 10 tags.",
  "tag bad len": "Each tag must be 1-32 characters long.",
  "insufficient usdc allowance":
    "The USDC approval is too low for this reward. Approve the amount first, then try again.",

  // Entering a contest / taking a bounty
  "contest closed": "This contest no longer accepts entries.",
  "contest full": "This contest is full.",
  "already entered": "This identity has already entered this contest.",
  "agent only: provide agentid": "This bounty is for registered agents only. Enter with an agent ID.",
  "human only: no agentid": "This bounty is for humans only. Enter without an agent ID.",
  "agent only: caller is not agent owner": AGENT_OWNER,
  "not whitelisted": "This bounty is reserved for a specific provider, and this wallet is not it.",
  "invalid entry": NO_SUCH_ENTRY,
  "not entrant": "Only the wallet that made this entry can change it.",
  "already taken": "Someone else already took this bounty.",
  "bounty expired": "This bounty's deadline has passed.",
  "bond bounty: too close to deadline": "This bounty needs a worker bond and its deadline is less than 12 hours away.",
  "bounty not found": NOT_FOUND,

  // Submitting and reviewing
  "not assigned provider": "Only the worker assigned to this bounty can submit work.",
  "already submitted": "Work was already submitted for this bounty.",
  "no submission": "No work has been submitted yet.",
  "only poster": NOT_POSTER,
  "review ended": "The review period has ended.",
  "review active": "The poster's review period is still running, so this cannot be settled yet.",
  "contest still open": "The contest is still accepting entries. Wait until it closes.",
  "contest rejected": "All entries in this contest were already rejected.",
  "contest not rejected": "This contest has not been rejected.",
  "no entries": "This contest has no entries.",
  "invalid winner count": "Pick at least one entry and no more than the number of winners set for this contest.",
  "invalid scores": "Give one score for each selected entry.",
  "score > 100": BAD_SCORE,
  "score>100": BAD_SCORE,
  "penalty>100": "The reputation penalty must be between 0 and 100.",
  "duplicate winner": "The same entry was selected twice.",
  resolved: SETTLED,
  "in dispute": IN_DISPUTE,
  "rejection pending": "A rejection is pending on this bounty.",
  "already rejected": "This submission was already rejected.",
  "approval window open": "The poster still has time to review, so auto-approval is not available yet.",
  "approval window elapsed, use autoapprove": "The review window has ended. Use auto-approve to pay the worker.",
  unauthorized: "Only the poster or the assigned worker can do that.",

  // Rejections, challenges and disputes
  "no pending rejection": "There is no pending rejection.",
  "already challenged": "This has already been challenged.",
  "already in dispute": IN_DISPUTE_ALREADY,
  "only worker": "Only the worker can do that.",
  "challenge window closed": CHALLENGE_CLOSED,
  "challenge window open": CHALLENGE_OPEN,
  "challenge window active": CHALLENGE_OPEN,
  "has challenges": "This rejection was challenged, so it has to be resolved first.",
  "no challenges": "There are no open challenges.",
  "not challenger": "Only entries that were challenged can be selected here.",
  "no overdue challenge": "No challenge response is overdue yet.",
  "unanswered challenge": NOT_YET_RESPONDED,
  "response window closed": RESPONSE_CLOSED,
  "arbitrator window ended": "The arbitrator window has ended.",
  "arbitrator window active": ARBITRATOR_STILL,
  "arbitrator window open": ARBITRATOR_STILL,
  "use challengerejection": "A rejection is pending. Challenge it instead of opening a dispute.",
  "not in dispute": "This bounty is not in dispute.",
  "already responded": "A response was already sent.",
  "respondent replied": "The other party already replied, so only the arbitrator can rule now.",
  "not the respondent": "Only the other party in this dispute can respond.",
  "window still open": "The response window is still open.",
  "use claimdefaultruling": "Nobody has responded, so use the default ruling instead.",
  "only arbitrator": NOT_ARBITRATOR,

  // Cancelling, expiring, withdrawing
  "already taken, cannot cancel": "Someone already took this bounty, so it can no longer be cancelled.",
  "has entries": "This contest already has entries, so it cannot be cancelled or expired.",
  "has submission": "Work was submitted, so this bounty cannot be expired.",
  "not expired yet": "This bounty has not expired yet.",
  "ac job not expired": "The escrow job has not expired yet.",
  "nothing to withdraw": "There is nothing to withdraw.",
  "only identity owner": "Only the owner of that agent identity can withdraw.",

  // Role handover (admin only)
  "next=0": "The new address cannot be empty.",
  "not pending": "This address has not been nominated for that role.",
  "only owner": ADMIN_ONLY,
  "only fee recipient": ADMIN_ONLY,
};

const CID_LABELS: Record<string, string> = {
  ipfsdesc: "description",
  ipfsresult: "submission",
  response: "response",
  ipfsresponse: "response",
  reason: "reason",
  ipfsreason: "reason",
  ipfsevidence: "evidence",
  ruling: "ruling",
  ipfsruling: "ruling",
};

function messageForReason(reasonRaw: string): string | undefined {
  const reason = reasonRaw.trim().toLowerCase();
  const direct = REVERT_MESSAGES[reason];
  if (direct) return direct;
  const empty = /^empty (\w+)$/.exec(reason);
  if (empty) return `The ${CID_LABELS[empty[1]] ?? "required content"} is missing. Add it and try again.`;
  const tooLong = /^(\w+) too long$/.exec(reason);
  if (tooLong) return `The ${CID_LABELS[tooLong[1]] ?? "content"} is too long. Shorten it and try again.`;
  // Token-level failures come back as free text from the USDC contract itself.
  if (/transfer amount exceeds balance|insufficient balance|exceeds balance/.test(reason)) return USDC_BALANCE;
  if (/exceeds allowance|insufficient allowance|erc20: insufficient/.test(reason)) return USDC_ALLOWANCE;
  return undefined;
}

// ─── Other messages ──────────────────────────────────────────────────────────

const REJECTED = "Transaction rejected in your wallet.";
const NETWORK_BUSY = "The network is busy, try again in a few seconds.";
const USDC_BALANCE = "You do not have enough USDC in this wallet for this amount.";
const USDC_ALLOWANCE = "The USDC approval is too low for this amount. Approve it first, then try again.";
const NOT_CONNECTED = "Connect your wallet first (top right) to do this.";
const WRONG_CHAIN = "Switch your wallet to the network this site uses, then try again.";
const REQUEST_PENDING = "Your wallet already has a request waiting. Finish or reject it there, then try again.";
const MINED_REVERT =
  "The transaction was mined but failed on-chain, so nothing changed (the gas was still spent). Refresh the page and check the current state before trying again.";

function gasMessage(ctx?: TxErrorContext): string {
  let symbol = ctx?.nativeSymbol;
  if (!symbol) {
    try {
      symbol = getActiveNetwork().nativeCurrency.symbol;
    } catch {
      symbol = undefined;
    }
  }
  return symbol
    ? `You need a little ${symbol} in this wallet to pay gas.`
    : "You need a little of this network's gas token in this wallet to pay gas.";
}

// ─── Sanitising free text ────────────────────────────────────────────────────

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Makes untrusted error text safe to show: no URLs or hosts (RPC endpoints often
 * carry API keys), no long hex (call data, hashes), no long opaque tokens, one
 * line, at most `max` characters.
 */
export function sanitizeDetail(input: string, max = 140): string {
  let text = input
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]*/gi, " ")
    .replace(/\bwww\.[^\s"'<>)\]]*/gi, " ")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s"'<>)\]]*/gi, " ")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, " ")
    .replace(/\b(?=[a-z0-9.-]*[a-z.])[a-z0-9.-]+:\d{2,5}\b/gi, " ")
    .replace(/\b(?:Docs|Version|URL|Request body|Request Arguments):[^\n]*/gi, " ")
    .replace(/0x[0-9a-fA-F]{41,}/g, "[data]")
    .replace(/\b0x[0-9a-fA-F]{40}\b/g, shortAddress)
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[data]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  return text;
}

// ─── Walking the error ───────────────────────────────────────────────────────

type Node = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The error followed down its `.cause` chain (outermost first). Works for any shape. */
function walk(error: unknown): Node[] {
  if (error === null || error === undefined) return [];
  if (typeof error !== "object" && typeof error !== "function") return [{ message: String(error) }];
  const nodes: Node[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current) && nodes.length < 12) {
    seen.add(current);
    nodes.push(current as Node);
    current = (current as Node).cause;
  }
  if (typeof current === "string" && current) nodes.push({ message: current });
  return nodes;
}

/**
 * Text of one node. A viem BaseError's `message` also embeds the whole call
 * (arguments, URLs, request body), so prefer its `shortMessage` and `details`.
 */
function textOf(node: Node): string {
  const parts = [str(node.shortMessage) ?? str(node.message), str(node.details)];
  return parts.filter(Boolean).join("\n");
}

type Revert = { custom: { name: string; args: readonly unknown[] } } | { reason: string };

function fromHex(data: string): Revert | undefined {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) return undefined;
  try {
    const decoded = decodeErrorResult({ abi: ERRORS_ABI, data: data as Hex });
    const args = (decoded.args ?? []) as readonly unknown[];
    // viem also decodes Solidity's built-in Error(string) and Panic(uint256).
    const name: string = decoded.errorName;
    if (name === "Error") return { reason: String(args[0] ?? "") };
    if (name === "Panic") return { reason: `Panic ${String(args[0] ?? "")}`.trim() };
    return { custom: { name, args } };
  } catch {
    return undefined;
  }
}

function cleanReason(raw: string): string {
  return raw
    .replace(/^execution reverted:?\s*/i, "")
    .replace(/^reverted with reason string\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\.$/, "")
    .trim();
}

function findRevert(nodes: Node[]): Revert | undefined {
  for (const node of nodes) {
    // 1. viem already decoded it with the caller's ABI.
    const data = node.data;
    if (data && typeof data === "object") {
      const decoded = data as { errorName?: unknown; args?: unknown };
      if (typeof decoded.errorName === "string") {
        const args = Array.isArray(decoded.args) ? (decoded.args as unknown[]) : [];
        if (decoded.errorName === "Error") return { reason: String(args[0] ?? "") };
        if (decoded.errorName === "Panic") return { reason: `Panic ${String(args[0] ?? "")}`.trim() };
        return { custom: { name: decoded.errorName, args } };
      }
    }
    // 2. Raw revert data that the caller's ABI could not decode: try ours.
    for (const hex of [str(node.raw), str(data)]) {
      const decoded = hex ? fromHex(hex) : undefined;
      if (decoded) return decoded;
    }
    // 3. viem's own reason string.
    const name = str(node.name);
    const reason = str(node.reason);
    if (reason && name && /RevertedError$/.test(name)) {
      const cleaned = cleanReason(reason);
      if (cleaned) return { reason: cleaned };
    }
  }
  // 4. Nodes that only carry the RPC message ("execution reverted: paused").
  for (const node of nodes) {
    const text = textOf(node);
    const quoted = /reverted with reason string '([^']*)'/i.exec(text);
    if (quoted?.[1]) return { reason: quoted[1] };
    const plain = /execution reverted(?: with reason)?:\s*([^\n]+)/i.exec(text);
    if (plain?.[1]) {
      const cleaned = cleanReason(plain[1]);
      if (cleaned) return { reason: cleaned };
    }
  }
  return undefined;
}

function pickDetail(nodes: Node[]): string {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const detail = sanitizeDetail(textOf(nodes[i]));
    if (detail && detail !== "[object Object]") return detail;
  }
  return "";
}

const REJECT_TEXT =
  /user (?:rejected|denied|declined|cancell?ed)|rejected the request|request (?:was )?(?:rejected|denied|declined|cancell?ed)|denied (?:transaction|message) signature|action_rejected|^(?:signature|transaction) cancelled$/im;
const GAS_TEXT =
  /insufficient funds|exceeds the balance of the account|intrinsic gas too low|gas required exceeds allowance|insufficient (?:balance )?for gas/i;
const USDC_BALANCE_TEXT = /transfer amount exceeds balance|erc20insufficientbalance|insufficient (?:usdc )?balance/i;
const USDC_ALLOWANCE_TEXT =
  /transfer amount exceeds allowance|erc20insufficientallowance|insufficient (?:usdc )?allowance|exceeds allowance/i;
const NETWORK_TEXT =
  /rate.?limit|too many requests|\btimed? ?out\b|\btimeout\b|etimedout|econnreset|econnrefused|enotfound|failed to fetch|fetch failed|network ?error|network request failed|service unavailable|bad gateway|gateway time-?out|http request failed|gas estimate unavailable|over (?:the )?(?:rate )?limit|request limit/i;

function classify(nodes: Node[], ctx?: TxErrorContext): TxErrorInfo {
  const names = nodes.map((n) => str(n.name));
  const hasName = (...wanted: string[]) => names.some((n) => n !== undefined && wanted.includes(n));
  const codes = nodes.map((n) => n.code);
  const statuses = nodes.map((n) => n.status);
  const all = nodes.map(textOf).join("\n");

  // 1. The person said no. Structured signals first, so nothing else can shadow them.
  if (codes.some((c) => c === 4001 || c === "ACTION_REJECTED") || hasName("UserRejectedRequestError")) {
    return { message: REJECTED, known: true, kind: "rejected" };
  }

  // 2. The contract (or the pre-flight simulation of it) reverted.
  const revert = findRevert(nodes);
  if (revert) {
    if ("custom" in revert) {
      const describe = CUSTOM_ERRORS[revert.custom.name];
      if (describe) return { message: describe(revert.custom.args), known: true, kind: "revert" };
      return unknown(nodes, ctx, revert.custom.name, "revert");
    }
    const mapped = messageForReason(revert.reason);
    if (mapped) {
      const kind = /allowance|balance/i.test(revert.reason) ? "usdc" : "revert";
      return { message: mapped, known: true, kind };
    }
    return unknown(nodes, ctx, revert.reason, "revert");
  }

  if (REJECT_TEXT.test(all)) return { message: REJECTED, known: true, kind: "rejected" };

  // 3. Money problems.
  if (hasName("InsufficientFundsError", "IntrinsicGasTooLowError") || GAS_TEXT.test(all)) {
    return { message: gasMessage(ctx), known: true, kind: "gas" };
  }
  if (USDC_BALANCE_TEXT.test(all)) return { message: USDC_BALANCE, known: true, kind: "usdc" };
  if (USDC_ALLOWANCE_TEXT.test(all)) return { message: USDC_ALLOWANCE, known: true, kind: "usdc" };

  // 4. Wallet state.
  if (hasName("ConnectorNotConnectedError")) return { message: NOT_CONNECTED, known: true, kind: "wallet" };
  if (
    hasName("ConnectorChainMismatchError", "ChainMismatchError", "ChainNotConfiguredError", "SwitchChainError") ||
    /does not match the target chain|chain mismatch/i.test(all)
  ) {
    return { message: WRONG_CHAIN, known: true, kind: "wallet" };
  }
  if (codes.some((c) => c === -32002) || hasName("ResourceUnavailableRpcError") || /already pending/i.test(all)) {
    return { message: REQUEST_PENDING, known: true, kind: "wallet" };
  }

  // 5. The transaction was mined and reverted (useTx cannot see why).
  if (/reverted on-chain/i.test(all)) return { message: MINED_REVERT, known: true, kind: "revert" };

  // 6. Passkey connector messages are already written for people.
  if (/passkey session expired/i.test(all)) {
    return { message: "Your passkey session expired. Sign in again.", known: true, kind: "passkey" };
  }
  const passkey = nodes.map(textOf).find((t) => /^Passkey\b/.test(t));
  if (passkey) return { message: sanitizeDetail(passkey.split("\n")[0]), known: true, kind: "passkey" };

  // 7. The RPC is rate limiting, slow or unreachable.
  if (
    hasName("TimeoutError", "HttpRequestError", "LimitExceededRpcError") ||
    codes.some((c) => c === -32005 || c === 429) ||
    statuses.some((s) => s === 429 || s === 502 || s === 503 || s === 504) ||
    NETWORK_TEXT.test(all)
  ) {
    return { message: NETWORK_BUSY, known: true, kind: "network" };
  }

  return unknown(nodes, ctx);
}

function unknown(
  nodes: Node[],
  ctx?: TxErrorContext,
  detailOverride?: string,
  kind: TxErrorKind = "unknown",
): TxErrorInfo {
  const lead = ctx?.action ? `Could not ${ctx.action}.` : "Something went wrong with this transaction.";
  const detail = sanitizeDetail(detailOverride ?? pickDetail(nodes));
  return { message: detail ? `${lead} Details: ${detail}` : `${lead} Please try again.`, known: false, kind };
}

/** Like {@link friendlyTxError}, but also says whether the error was recognised. */
export function classifyTxError(error: unknown, ctx?: TxErrorContext): TxErrorInfo {
  try {
    return classify(walk(error), ctx);
  } catch {
    // Error text must never be the reason an error cannot be shown.
    return { message: "Something went wrong with this transaction. Please try again.", known: false, kind: "unknown" };
  }
}

/** One short, safe sentence for any failure thrown while preparing, signing or sending a transaction. */
export function friendlyTxError(error: unknown, ctx?: TxErrorContext): string {
  return classifyTxError(error, ctx).message;
}
