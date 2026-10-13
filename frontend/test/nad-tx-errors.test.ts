import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  IntrinsicGasTooLowError,
  TimeoutError,
  UserRejectedRequestError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionData,
  parseAbi,
  stringToHex,
  type Abi,
  type Hex,
} from "viem";
import { BOUNTY_ADAPTER_V48_ABI } from "../lib/abi-v48";
import {
  confirmAction,
  describeMessageSignature,
  describeTransaction,
  describeTypedDataSignature,
  formatNative,
} from "../lib/nadConfirm";
import {
  KNOWN_CUSTOM_ERRORS,
  REVERT_MESSAGES,
  classifyTxError,
  formatUsdc,
  friendlyTxError,
  sanitizeDetail,
} from "../lib/txErrors";

const ABI = BOUNTY_ADAPTER_V48_ABI as unknown as Abi;
const NO_ERRORS_ABI: Abi = [];
const ADAPTER = "0x2222222222222222222222222222222222222222" as const;
const MON = { nativeSymbol: "MON" };

/** ABI-encoded Error(string), what a Solidity require(..., "reason") returns. */
const errorString = (reason: string): Hex =>
  `0x08c379a0${encodeAbiParameters([{ type: "string" }], [reason]).slice(2)}` as Hex;

/** What estimateContractGas throws: execution error -> reverted error. */
function viemRevert(data: Hex, abi: Abi = ABI, functionName = "enterContest") {
  const reverted = new ContractFunctionRevertedError({ abi, data, functionName });
  return new ContractFunctionExecutionError(reverted, {
    abi,
    functionName,
    args: [7n, 0n, "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"],
    contractAddress: ADAPTER,
    sender: "0x1111111111111111111111111111111111111111",
  });
}

/** Plain-object stand-in with the same shape viem produces, for duck-typing checks. */
const revertedLike = (extra: Record<string, unknown>) => ({
  name: "ContractFunctionExecutionError",
  shortMessage: 'The contract function "enterContest" reverted.',
  cause: { name: "ContractFunctionRevertedError", ...extra },
});

test("user rejection is recognised from code, name, wallet text and passkey cancellations", () => {
  const expected = "Transaction rejected in your wallet.";
  const cases: unknown[] = [
    { code: 4001, message: "whatever" },
    { name: "UserRejectedRequestError", message: "x" },
    new UserRejectedRequestError(new Error("User rejected the request.")),
    { name: "TransactionExecutionError", cause: { code: 4001 } },
    new Error("MetaMask Tx Signature: User denied transaction signature."),
    new Error("User rejected the request."),
    { code: "ACTION_REJECTED", message: "user rejected action" },
    new Error("Signature cancelled"),
    new Error("Transaction cancelled"),
  ];
  for (const error of cases) {
    const info = classifyTxError(error);
    assert.equal(info.message, expected);
    assert.equal(info.kind, "rejected");
    assert.equal(info.known, true);
  }
});

test("ReputationGateFailed explains the gate with the real counts (real viem classes)", () => {
  const data = encodeErrorResult({ abi: ABI, errorName: "ReputationGateFailed", args: [2n, 150n] });
  assert.equal(
    friendlyTxError(viemRevert(data)),
    "This bounty requires more reputation than this identity has (2 paid jobs, score sum 150).",
  );
  const single = encodeErrorResult({ abi: ABI, errorName: "ReputationGateFailed", args: [1n, 80n] });
  assert.equal(
    friendlyTxError(viemRevert(single)),
    "This bounty requires more reputation than this identity has (1 paid job, score sum 80).",
  );
});

test("a custom error is still explained when the caller's ABI did not list it", () => {
  const data = encodeErrorResult({ abi: ABI, errorName: "ReputationGateFailed", args: [0n, 0n] });
  const error = viemRevert(data, NO_ERRORS_ABI);
  // viem could not decode it, so only the raw payload is left on the error.
  const reverted = error.cause as ContractFunctionRevertedError;
  assert.equal(reverted.data, undefined);
  assert.equal(reverted.raw, data);
  assert.equal(
    friendlyTxError(error),
    "This bounty requires more reputation than this identity has (0 paid jobs, score sum 0).",
  );
});

test("ReputationGateFailed works on plain objects (decoded data, or args missing)", () => {
  assert.equal(
    friendlyTxError(revertedLike({ data: { errorName: "ReputationGateFailed", args: [3n, 210n] } })),
    "This bounty requires more reputation than this identity has (3 paid jobs, score sum 210).",
  );
  assert.equal(
    friendlyTxError(revertedLike({ data: { errorName: "ReputationGateFailed" } })),
    "This bounty requires more reputation than this identity has.",
  );
});

test("every custom error in the real V4.8 ABI has a friendly message", () => {
  const errors = (ABI as readonly { type: string; name?: string }[]).filter((item) => item.type === "error");
  assert.ok(errors.length >= 8);
  const names = errors.map((e) => e.name as string).sort();
  for (const name of names) {
    assert.ok(KNOWN_CUSTOM_ERRORS.includes(name), `txErrors.ts has no message for ${name}`);
  }
  for (const item of errors) {
    const inputs = (item as unknown as { inputs: { type: string }[] }).inputs;
    const args = inputs.map((input) => (input.type === "address" ? ADAPTER : 5000000n));
    const data = encodeErrorResult({ abi: ABI, errorName: item.name as string, args } as never);
    // Empty ABI forces the raw-data fallback, so this also proves the inlined
    // error fragments in txErrors.ts match the real selectors.
    const info = classifyTxError(viemRevert(data, NO_ERRORS_ABI));
    assert.equal(info.known, true, `${item.name} was not recognised from raw data`);
    assert.ok(!info.message.includes("Details:"), `${item.name}: ${info.message}`);
    assert.ok(info.message.length > 20 && info.message.length < 200, `${item.name}: ${info.message}`);
  }
});

test("the other custom errors say something specific", () => {
  const encode = (errorName: string, args: unknown[]) =>
    classifyTxError(viemRevert(encodeErrorResult({ abi: ABI, errorName, args } as never), NO_ERRORS_ABI)).message;
  assert.match(encode("InvalidIdentity", []), /agent ID does not exist/);
  assert.match(encode("InvalidContestParams", []), /1-25 entries/);
  assert.match(encode("WrongBountyMode", []), /not available for this type of bounty/);
  assert.match(encode("InvalidGateScore", []), /between 0 and 100/);
  assert.match(encode("ReentrancyGuardReentrantCall", []), /Wait for your last transaction/);
  assert.match(encode("SafeERC20FailedOperation", [ADAPTER]), /USDC transfer failed/);
  assert.equal(
    encode("UnexpectedEscrowAmount", [4_500_000n, 5_000_000n]),
    "The escrow received 4.50 USDC instead of 5.00 USDC, so the transaction was stopped. Nothing was moved.",
  );
});

test("every plain revert string is mapped (table-driven, real viem classes)", () => {
  const entries = Object.entries(REVERT_MESSAGES);
  assert.ok(entries.length > 80);
  for (const [reason, message] of entries) {
    assert.ok(message.endsWith("."), `${reason}: message should be a sentence`);
    assert.ok(message.length <= 130, `${reason}: message too long`);
    const info = classifyTxError(viemRevert(errorString(reason)));
    assert.equal(info.message, message, `reason "${reason}"`);
    assert.equal(info.known, true);
    assert.ok(["revert", "usdc"].includes(info.kind));
  }
});

test("revert strings match regardless of case and arrive in the common RPC wordings", () => {
  const paused = REVERT_MESSAGES.paused;
  assert.equal(paused, "New activity is paused right now. Existing payouts and refunds still work.");
  for (const error of [
    revertedLike({ reason: "paused" }),
    revertedLike({ reason: "PAUSED" }),
    revertedLike({ reason: "execution reverted: paused" }),
    { message: "execution reverted: paused" },
    { shortMessage: "Execution reverted with reason: paused." },
    { message: "VM Exception while processing transaction: reverted with reason string 'paused'" },
  ]) {
    assert.equal(friendlyTxError(error), paused);
  }
  assert.equal(
    friendlyTxError(revertedLike({ reason: "approval window elapsed, use autoApprove" })),
    "The review window has ended. Use auto-approve to pay the worker.",
  );
  assert.equal(friendlyTxError(revertedLike({ reason: "contest closed" })), "This contest no longer accepts entries.");
  assert.equal(friendlyTxError(revertedLike({ reason: "contest full" })), "This contest is full.");
  assert.equal(
    friendlyTxError(revertedLike({ reason: "agent only: provide agentId" })),
    "This bounty is for registered agents only. Enter with an agent ID.",
  );
  assert.equal(
    friendlyTxError(revertedLike({ reason: "human only: no agentId" })),
    "This bounty is for humans only. Enter without an agent ID.",
  );
});

test("IPFS content label reverts get a readable name", () => {
  assert.equal(
    friendlyTxError(revertedLike({ reason: "empty ipfsResult" })),
    "The submission is missing. Add it and try again.",
  );
  assert.equal(
    friendlyTxError(revertedLike({ reason: "ipfsDesc too long" })),
    "The description is too long. Shorten it and try again.",
  );
});

test("every require() message in BountyAdapterV48.sol is mapped or deliberately unreachable", (t) => {
  const path = new URL("../../contracts/src/monad/BountyAdapterV48.sol", import.meta.url);
  if (!existsSync(path)) return t.skip("contract source is not next to the frontend in this checkout");
  const source = readFileSync(path, "utf8");
  // Constructor-only: no user transaction can reach these.
  const unreachable = new Set(["ac=0", "id=0", "rep=0", "usdc=0", "fee=0", "mirror=0"]);
  const messages = new Set<string>();
  let from = 0;
  for (;;) {
    const start = source.indexOf("require(", from);
    if (start < 0) break;
    let depth = 0;
    let quote = false;
    let end = -1;
    let lastComma = -1;
    for (let i = start + "require".length; i < source.length; i++) {
      const ch = source[i];
      if (ch === '"') quote = !quote;
      if (quote) continue;
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
      if (ch === "," && depth === 1) lastComma = i;
    }
    from = end > 0 ? end : start + 1;
    if (end < 0 || lastComma < 0) continue;
    const last = source.slice(lastComma + 1, end).trim();
    const literal = /^"([^"]*)"$/.exec(last);
    if (literal) messages.add(literal[1]);
  }
  assert.ok(messages.size > 70, `parsed only ${messages.size} messages`);
  const missing = [...messages].filter((m) => !unreachable.has(m) && !(m.toLowerCase() in REVERT_MESSAGES));
  assert.deepEqual(missing, []);
  // And the table must not keep messages for reverts the contract no longer has.
  const lowered = new Set([...messages].map((m) => m.toLowerCase()));
  assert.deepEqual(
    Object.keys(REVERT_MESSAGES).filter((key) => !lowered.has(key)),
    [],
  );
});

test("not enough gas token names the chain's token", () => {
  const sentence = "You need a little MON in this wallet to pay gas.";
  const cases: unknown[] = [
    new InsufficientFundsError(),
    new IntrinsicGasTooLowError(),
    new Error("insufficient funds for gas * price + value: address 0x1111 have 0 want 1500000000000"),
    {
      shortMessage:
        "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.",
    },
    { name: "TransactionExecutionError", cause: { name: "InsufficientFundsError", message: "x" } },
  ];
  for (const error of cases) {
    const info = classifyTxError(error, MON);
    assert.equal(info.message, sentence);
    assert.equal(info.kind, "gas");
  }
  assert.equal(
    friendlyTxError(new Error("Insufficient funds"), { nativeSymbol: "ETH" }),
    "You need a little ETH in this wallet to pay gas.",
  );
  // Without a hint it falls back to the active build's gas token.
  assert.match(friendlyTxError(new Error("Insufficient funds")), /^You need a little \w+ in this wallet to pay gas\.$/);
});

test("USDC balance and allowance problems are told apart from gas", () => {
  for (const error of [
    revertedLike({ reason: "ERC20: transfer amount exceeds balance" }),
    new Error("ERC20: transfer amount exceeds balance"),
  ]) {
    assert.equal(friendlyTxError(error, MON), "You do not have enough USDC in this wallet for this amount.");
  }
  for (const error of [
    revertedLike({ reason: "insufficient USDC allowance" }),
    revertedLike({ reason: "ERC20: transfer amount exceeds allowance" }),
    new Error("ERC20: insufficient allowance"),
  ]) {
    const info = classifyTxError(error, MON);
    assert.equal(info.kind, "usdc");
    assert.match(info.message, /approval is too low/);
  }
  // OpenZeppelin's ERC20InsufficientBalance, raised by the USDC token itself.
  const erc20 = parseAbi([
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  ]);
  const balance = encodeErrorResult({
    abi: erc20,
    errorName: "ERC20InsufficientBalance",
    args: [ADAPTER, 1_250_000n, 5_000_000n],
  });
  assert.equal(
    friendlyTxError(viemRevert(balance, NO_ERRORS_ABI, "approve"), MON),
    "You do not have enough USDC in this wallet (balance 1.25, needed 5.00).",
  );
  const allowance = encodeErrorResult({
    abi: erc20,
    errorName: "ERC20InsufficientAllowance",
    args: [ADAPTER, 0n, 5_000_000n],
  });
  assert.match(friendlyTxError(viemRevert(allowance, NO_ERRORS_ABI, "enterContest"), MON), /approval is too low/);
});

test("RPC rate limits and timeouts become one calm sentence without leaking the endpoint", () => {
  const secretUrl = "https://rpc.example-node.io/v3/0123456789abcdef0123456789abcdef";
  const busy = "The network is busy, try again in a few seconds.";
  const cases: unknown[] = [
    new HttpRequestError({ url: secretUrl, status: 429, body: { method: "eth_call" }, details: "Too Many Requests" }),
    new TimeoutError({ url: secretUrl, body: { method: "eth_estimateGas" } }),
    new HttpRequestError({ url: secretUrl, body: { method: "eth_call" } }),
    { name: "RpcRequestError", code: -32005, message: "RPC Request failed.", details: "Limit exceeded" },
    new Error(`fetch failed for ${secretUrl}`),
    new Error("Request timed out"),
    { status: 503, message: "x" },
    new Error("over rate limit"),
    new Error("Monad gas estimate unavailable"),
  ];
  for (const error of cases) {
    const info = classifyTxError(error, MON);
    assert.equal(info.message, busy);
    assert.equal(info.kind, "network");
    assert.ok(!info.message.includes("example-node"));
  }
  // A real viem error wraps the URL in its own long message; none of it may surface.
  const wrapped = new ContractFunctionExecutionError(
    new HttpRequestError({ url: secretUrl, status: 429, body: { method: "eth_call" } }),
    { abi: ABI, functionName: "enterContest", args: [1n, 0n, "ipfs://x"], contractAddress: ADAPTER },
  );
  assert.equal(friendlyTxError(wrapped), busy);
});

test("a contract function name containing 'Timeout' is not mistaken for a network timeout", () => {
  const info = classifyTxError({ shortMessage: 'The contract function "claimArbitratorTimeout" failed.' });
  assert.equal(info.kind, "unknown");
});

test("unknown errors fall back to a short sentence with a clean, truncated detail", () => {
  const rpc = "https://eth-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const calldata = `0x${"ab".repeat(400)}`;
  const info = classifyTxError(
    new Error(`Weird failure calling ${rpc} with data ${calldata} and key AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`),
  );
  assert.equal(info.known, false);
  assert.equal(info.kind, "unknown");
  assert.ok(info.message.startsWith("Something went wrong with this transaction. Details: Weird failure calling"));
  for (const bad of ["http", "alchemy", "AbCdEf", "abab", "v2/"]) {
    assert.ok(!info.message.includes(bad), `leaked ${bad}: ${info.message}`);
  }
  const detail = info.message.split("Details: ")[1];
  assert.ok(detail.length <= 140, `detail is ${detail.length} chars`);

  const long = classifyTxError(new Error("word ".repeat(200)));
  assert.ok(long.message.split("Details: ")[1].length <= 140);
  assert.ok(long.message.endsWith("…"));

  const withAction = classifyTxError(new Error("kaboom"), { action: "enter the contest" });
  assert.equal(withAction.message, "Could not enter the contest. Details: kaboom");
  assert.equal(friendlyTxError(new Error("kaboom"), { action: "enter the contest" }), withAction.message);
});

test("unknown revert reasons and custom errors surface their (safe) name", () => {
  const reason = classifyTxError(revertedLike({ reason: "some brand new require message" }));
  assert.equal(reason.known, false);
  assert.equal(reason.kind, "revert");
  assert.equal(reason.message, "Something went wrong with this transaction. Details: some brand new require message");
  const custom = classifyTxError(revertedLike({ data: { errorName: "BrandNewError", args: [] } }));
  assert.equal(custom.known, false);
  assert.match(custom.message, /Details: BrandNewError$/);
});

test("non-Error values never throw and never print 'undefined' or '[object Object]'", () => {
  const plain = "Something went wrong with this transaction. Please try again.";
  for (const value of [undefined, null, {}, [], { foo: 1 }, Symbol("s"), () => 1, NaN]) {
    const message = friendlyTxError(value);
    assert.equal(typeof message, "string");
    assert.ok(!message.includes("undefined") && !message.includes("[object Object]"), message);
  }
  assert.equal(friendlyTxError(undefined), plain);
  assert.equal(friendlyTxError(null), plain);
  assert.equal(friendlyTxError({}), plain);
  assert.equal(friendlyTxError("boom"), "Something went wrong with this transaction. Details: boom");
  assert.equal(friendlyTxError(42), "Something went wrong with this transaction. Details: 42");
  assert.equal(friendlyTxError("User rejected the request."), "Transaction rejected in your wallet.");
  // Cause cycles and hostile getters are survivable.
  const loop: Record<string, unknown> = { message: "loop" };
  loop.cause = loop;
  assert.equal(friendlyTxError(loop), "Something went wrong with this transaction. Details: loop");
  const hostile = {
    get message(): string {
      throw new Error("boom");
    },
  };
  assert.equal(friendlyTxError(hostile), plain);
});

test("wallet and chain states get their own sentence", () => {
  assert.equal(
    friendlyTxError({ name: "ConnectorNotConnectedError" }),
    "Connect your wallet first (top right) to do this.",
  );
  assert.match(friendlyTxError({ name: "ChainMismatchError", message: "x" }), /^Switch your wallet/);
  assert.match(
    friendlyTxError({ code: -32002, message: "Request of type 'eth_requestAccounts' already pending" }),
    /already has a request/,
  );
  assert.match(friendlyTxError(new Error("Transaction reverted on-chain")), /mined but failed on-chain/);
  assert.equal(
    friendlyTxError(new Error("Passkey session expired. Sign in again.")),
    "Your passkey session expired. Sign in again.",
  );
  assert.equal(
    friendlyTxError(new Error("Passkey transaction exceeds 0.15 MON gas budget")),
    "Passkey transaction exceeds 0.15 MON gas budget",
  );
});

test("no friendly message ever carries a URL, call data or an API key", () => {
  const secretUrl =
    "https://rpc.example-node.io/v3/0123456789abcdef0123456789abcdef?apikey=SECRETSECRETSECRETSECRET1234";
  const calldata = `0x${"cd".repeat(200)}`;
  const samples: unknown[] = [
    new HttpRequestError({ url: secretUrl, status: 500, body: { method: "eth_call", params: [calldata] } }),
    new Error(`${secretUrl} ${calldata}`),
    new ContractFunctionExecutionError(new BaseError(`mystery ${secretUrl}`), {
      abi: ABI,
      functionName: "enterContest",
      args: [1n, 0n, calldata],
      contractAddress: ADAPTER,
    }),
    viemRevert(errorString(`weird ${secretUrl}`)),
    { message: `wss://node.example/socket?s=ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 ${calldata}` },
    { shortMessage: `localhost:8545 and 10.0.0.5:8545 and node.example.com/path ${calldata}` },
  ];
  for (const sample of samples) {
    const message = friendlyTxError(sample);
    assert.ok(!/https?:|wss?:|apikey|example-node|example\.com|localhost|10\.0\.0\.5|socket/i.test(message), message);
    assert.ok(!/0x[0-9a-fA-F]{20,}/.test(message), message);
    assert.ok(!/SECRET|ABCDEFGHIJKLMNOPQRSTUVWXYZ|cdcdcd/.test(message), message);
    assert.ok(message.length < 260, message);
  }
});

test("sanitizeDetail and formatUsdc", () => {
  assert.equal(sanitizeDetail("see https://a.b/c?key=1 now"), "see now");
  assert.equal(sanitizeDetail("addr 0x1111111111111111111111111111111111111111 ok"), "addr 0x1111…1111 ok");
  assert.equal(sanitizeDetail(`data ${"0x" + "f".repeat(70)} end`), "data [data] end");
  assert.equal(sanitizeDetail("  a \n\n b\t c  "), "a b c");
  assert.equal(sanitizeDetail("x".repeat(10), 5), "xxxx…");
  assert.equal(formatUsdc(0n), "0.00");
  assert.equal(formatUsdc(5_000_000n), "5.00");
  assert.equal(formatUsdc(250_000n), "0.25");
  assert.equal(formatUsdc(1_234_567n), "1.234567");
  assert.equal(formatUsdc(1_250_500_000n), "1,250.50");
});

// ─── Passkey confirmation copy (lib/nadConfirm.ts) ───────────────────────────

const USDC = "0x3333333333333333333333333333333333333333";
const IDENTITY = "0x4444444444444444444444444444444444444444";
const WALLET = "0x1111111111111111111111111111111111111111";
const SIGNING = {
  chainName: "Monad Testnet",
  appName: "NadBounty",
  nativeSymbol: "MON",
  from: WALLET,
  adapter: ADAPTER,
  usdc: USDC,
  identity: IDENTITY,
  gas: 120_000n,
  maxFee: 12_000_000_000_000_000n,
};

test("USDC approval is described in dollars, with the raw data only in the details", () => {
  const approve = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
  const data = encodeFunctionData({ abi: approve, functionName: "approve", args: [ADAPTER, 5_000_000n] });
  const copy = describeTransaction({ to: USDC, data, value: "0x0" }, SIGNING);
  assert.equal(copy.title, "Approve 5.00 USDC for NadBounty");
  assert.match(copy.body, /Lets NadBounty use up to 5\.00 USDC from this wallet\. Nothing is sent yet\./);
  assert.match(copy.body, /Network: Monad Testnet/);
  assert.match(copy.body, /Contract: USDC \(0x3333…3333\)/);
  assert.match(copy.body, /No MON is sent with this\./);
  assert.match(copy.body, /Network fee: up to 0\.012 MON/);
  assert.ok(!copy.body.includes(data), "raw data must not be in the body");
  assert.ok(!copy.title.includes(data));
  assert.ok(copy.details.includes(data));
  assert.ok(copy.details.includes(`To: ${USDC}`));
  assert.ok(copy.details.includes(`From: ${WALLET}`));
  assert.ok(copy.details.includes("Function: approve(address spender, uint256 amount)"));
  assert.ok(copy.details.includes("Gas limit: 120000"));
  const revoke = describeTransaction(
    { to: USDC, data: encodeFunctionData({ abi: approve, functionName: "approve", args: [ADAPTER, 0n] }) },
    SIGNING,
  );
  assert.equal(revoke.title, "Remove the USDC approval for NadBounty");
});

test("adapter calls are described by what they do", () => {
  const call = (functionName: string, args: unknown[]) =>
    describeTransaction({ to: ADAPTER, data: encodeFunctionData({ abi: ABI, functionName, args } as never) }, SIGNING);
  assert.equal(call("enterContest", [7n, 0n, "ipfs://x"]).title, "Enter contest #7");
  assert.equal(call("enterContest", [7n, 12n, "ipfs://x"]).title, "Enter contest #7 as agent #12");
  assert.equal(call("takeBounty", [3n, 0n]).title, "Take bounty #3");
  assert.equal(call("approveBounty", [3n, 90]).title, "Approve bounty #3 (score 90/100)");
  assert.equal(call("claimContestDefault", [5n]).title, "Claim contest default (bounty #5)");
  assert.equal(call("withdraw", []).title, "Withdraw your pending USDC");
  const created = call("createBounty", [
    {
      provider: "0x0000000000000000000000000000000000000000",
      reward: 25_000_000n,
      deadline: 1_900_000_000n,
      ipfsDescHash: "ipfs://x",
      category: "dev",
      tags: [],
      agentOnly: false,
      humanOnly: false,
      requireWorkerBond: false,
      contest: true,
      maxEntries: 10,
      winners: 2,
      minJobs: 0n,
      minAvgScore: 0,
    },
  ]);
  assert.equal(created.title, "Post a contest with a 25.00 USDC reward");
  assert.match(created.body, /locked in escrow/);
  assert.match(created.body, /Contract: NadBounty \(0x2222…2222\)/);
  assert.ok(created.details.includes('"reward":"25000000"'));
});

test("an unreadable call still says where it goes and keeps the payload in the details", () => {
  const data = "0xdeadbeef00000000000000000000000000000000000000000000000000000000000000ff";
  const copy = describeTransaction({ to: ADAPTER, data }, SIGNING);
  assert.equal(copy.title, "Contract call to 0x2222…2222");
  assert.match(copy.body, /could not be read/);
  assert.ok(!copy.body.includes("deadbeef"));
  assert.ok(copy.details.includes(data));
  const stranger = describeTransaction({ to: "0x5555555555555555555555555555555555555555", data: "0x" }, SIGNING);
  assert.equal(stranger.title, "Contract call to 0x5555…5555");
  // A malformed `to` never reaches the dialog text verbatim.
  assert.equal(
    describeTransaction({ to: "<img src=x onerror=alert(1)>", data: "0x" }, SIGNING).title,
    "Contract call to an unknown address",
  );
});

test("signature prompts say what they are, and never claim more than they know", () => {
  const key = describeMessageSignature(
    stringToHex("NadBounty contest encryption key v1\nchain: 10143\nPurpose: derive a private encryption key locally."),
    SIGNING,
  );
  assert.equal(key.title, "Unlock your contest encryption key");
  assert.equal(key.body, "Sign to unlock your contest encryption key. This signature does not move funds.");
  assert.ok(key.details.includes(`Signer: ${WALLET}`));
  assert.ok(key.details.includes("chain: 10143"));

  const other = describeMessageSignature(stringToHex("ArcBounty IPFS pin\naddress: 0x1\ntimestamp: 1"), SIGNING);
  assert.equal(other.title, "Sign a message");
  assert.match(other.body, /It starts with: "ArcBounty IPFS pin"/);
  assert.match(other.body, /does not send a transaction or spend funds on its own/);

  const binary = describeMessageSignature("0x00ff00ff", SIGNING);
  assert.match(binary.body, /It is not readable text\./);
  assert.ok(binary.details.includes("Message (hex): 0x00ff00ff"));
});

test("typed data warns when the type looks like a token permission", () => {
  const permit = describeTypedDataSignature(
    { primaryType: "Permit", domain: { name: "USD Coin", chainId: 10143 }, message: { value: 5n } },
    SIGNING,
  );
  assert.equal(permit.title, "Sign a Permit request");
  assert.match(permit.body, /can let someone else move your tokens/);
  assert.ok(permit.details.includes('"value": "5"'));
  const odd = describeTypedDataSignature({ primaryType: "<script>", domain: { name: "<b>x</b>" } }, SIGNING);
  assert.equal(odd.title, "Sign structured data");
  assert.ok(!odd.body.includes("<"));
});

test("formatNative, and confirmAction fails closed without a DOM", async () => {
  assert.equal(formatNative(0n), "0");
  assert.equal(formatNative(12_000_000_000_000_000n), "0.012");
  assert.equal(formatNative(1_500_000_000_000_000_000n), "1.5");
  assert.equal(formatNative(1n), "less than 0.000001");
  assert.equal(typeof (globalThis as { document?: unknown }).document, "undefined");
  assert.equal(await confirmAction({ title: "t", body: "b" }), false);
});
