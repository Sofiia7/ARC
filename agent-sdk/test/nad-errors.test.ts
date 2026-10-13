import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  EstimateGasExecutionError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  encodeErrorResult,
  keccak256,
  toHex,
  type Abi,
} from "viem";
import { BOUNTY_ADAPTER_V48_ABI } from "../src/abi-v48.js";
import { NadBountyAgent } from "../src/NadBountyAgent.js";
import { NadBountyError, redactUrls, toNadError } from "../src/nadErrors.js";
import { THROWAWAY_KEYS, addresses, mainnetWiring, mock, resetMocks } from "./helpers/nadMock.js";

vi.mock("viem", async (importOriginal) => (await import("./helpers/nadMock.js")).viemMock(await importOriginal()));
vi.mock("../src/signers/viemSigner.js", async () => (await import("./helpers/nadMock.js")).signerMock());

const RPC = "https://rpc.example.invalid/v1/very-secret-key";
const SOURCE = fileURLToPath(new URL("../../contracts/src/monad/BountyAdapterV48.sol", import.meta.url));
const errorAbi = [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }] as const;

function revertedWith(abi: Abi, errorName: string, args: readonly unknown[], functionName = "takeBounty") {
  const data = encodeErrorResult({ abi, errorName, args } as never);
  const revert = new ContractFunctionRevertedError({ abi: BOUNTY_ADAPTER_V48_ABI, data, functionName });
  return new EstimateGasExecutionError(
    new ContractFunctionExecutionError(revert, {
      abi: BOUNTY_ADAPTER_V48_ABI,
      functionName,
      args: [1n, 0n],
      contractAddress: addresses.owner,
    }),
    { account: undefined, to: addresses.owner, data: "0x" } as never,
  );
}
const reverted = (reason: string) => revertedWith(errorAbi as unknown as Abi, "Error", [reason]);

describe("custom adapter errors", () => {
  it("explains ReputationGateFailed with the identity's numbers", () => {
    const error = toNadError(revertedWith(BOUNTY_ADAPTER_V48_ABI, "ReputationGateFailed", [2n, 150n]), "takeBounty");
    expect(error).toBeInstanceOf(NadBountyError);
    expect((error as NadBountyError).code).toBe("ReputationGateFailed");
    expect((error as NadBountyError).args).toEqual([2n, 150n]);
    expect(error.message).toMatch(
      /^takeBounty: Reputation gate not met: this identity has 2 paid job\(s\) with a score sum of 150 \(average 75\)/,
    );
  });
  it("handles an identity with no history", () => {
    expect(toNadError(revertedWith(BOUNTY_ADAPTER_V48_ABI, "ReputationGateFailed", [0n, 0n])).message).toContain(
      "(average n/a)",
    );
  });
  it("explains the other custom errors", () => {
    const messageOf = (name: string, args: readonly unknown[] = []) =>
      toNadError(revertedWith(BOUNTY_ADAPTER_V48_ABI, name, args)).message;
    expect(messageOf("InvalidIdentity")).toMatch(/agentId does not exist.*agentId 0/);
    expect(messageOf("InvalidContestParams")).toMatch(/1-25 entries.*cannot require a worker bond/);
    expect(messageOf("UnexpectedEscrowAmount", [1_000_000n, 2_000_000n])).toMatch(
      /released 1 USDC but 2 USDC was expected/,
    );
    expect(messageOf("WrongBountyMode")).toMatch(/single-taker bounties and contests/i);
    expect(messageOf("InvalidGateScore")).toMatch(/between 0 and 100/);
    expect(messageOf("SafeERC20FailedOperation", [addresses.owner])).toMatch(/USDC transfer failed/);
    expect(messageOf("ReentrancyGuardReentrantCall")).toMatch(/reentrant/);
  });
  it("has a specific message for every custom error in the adapter ABI", () => {
    const names = BOUNTY_ADAPTER_V48_ABI.filter((item) => item.type === "error").map((item) => item.name);
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) {
      const abiItem = BOUNTY_ADAPTER_V48_ABI.find((item) => item.type === "error" && item.name === name)!;
      const args = abiItem.inputs.map((input) => (input.type === "address" ? addresses.owner : 1n));
      const { message, code } = toNadError(revertedWith(BOUNTY_ADAPTER_V48_ABI, name, args)) as NadBountyError;
      expect(code).toBe(name);
      expect(message, name).not.toMatch(/rejected the call with/);
    }
  });
  it("matches the real selector of InvalidIdentity (seen on Monad mainnet)", () => {
    expect(keccak256(toHex("InvalidIdentity()")).slice(0, 10)).toBe("0x178423dd");
  });
});

describe("revert strings", () => {
  it("maps the common ones to what is wrong", () => {
    const messageOf = (reason: string) => toNadError(reverted(reason), "createBounty").message;
    expect(messageOf("paused")).toMatch(/NadBounty is paused.*Settlements, refunds and withdrawals still work/);
    expect(messageOf("reward too low")).toMatch(/below the 1 USDC minimum/);
    expect(messageOf("reward exceeds maxBountyAmount")).toMatch(/per-bounty cap/);
    expect(messageOf("deadline in past")).toMatch(/absolute unix timestamp in seconds/);
    expect(messageOf("insufficient USDC allowance")).toMatch(/Approve the amount first/);
    expect(messageOf("agent only: caller is not agent owner")).toMatch(
      /neither the owner nor the current working wallet/,
    );
    expect(messageOf("already taken")).toBe("createBounty: This bounty has already been taken.");
    expect(messageOf("deadline too far")).toMatch(/more than 5 minutes/);
    expect(messageOf("invalid wallet sig")).toMatch(/NEW working wallet must sign/);
  });
  it("maps dynamic CID messages and keeps unknown reasons visible", () => {
    expect(toNadError(reverted("empty ipfsResult")).message).toMatch(/ipfsResult is empty/);
    expect(toNadError(reverted("ipfsDesc too long")).message).toMatch(/ipfsDesc is too long.*96 bytes/);
    expect(toNadError(reverted("something new")).message).toBe("The contract rejected the call: something new");
  });
  // Only meaningful inside the monorepo, where the Solidity source sits next to the SDK.
  it.skipIf(!existsSync(SOURCE))(
    "covers every revert string in the Solidity source with a specific message",
    async () => {
      const source = readFileSync(SOURCE, "utf8");
      const reasons = new Set<string>();
      for (const match of source.matchAll(/require\([^;]*?,\s*"([^"]+)"\s*\)/gs)) reasons.add(match[1]!);
      // Constructor guards, and the suffix of the string.concat(label, " too long") CID check (tested above).
      const ignored = new Set(["ac=0", "id=0", "rep=0", "usdc=0", "fee=0", "mirror=0", "next=0", " too long"]);
      expect(reasons.size).toBeGreaterThan(80);
      const generic = [];
      for (const reason of reasons) {
        if (ignored.has(reason)) continue;
        if (/rejected the call: /.test(toNadError(reverted(reason)).message)) generic.push(reason);
      }
      expect(generic).toEqual([]);
    },
  );
});

describe("failures that are not contract reverts", () => {
  it("never leaks the RPC URL, and does not chain the original error", () => {
    const http = new HttpRequestError({ url: RPC, body: { method: "eth_call" }, details: "fetch failed" });
    const error = toNadError(http, "getBounty");
    expect(error.message).not.toContain("very-secret-key");
    expect(error.message).not.toContain("rpc.example.invalid");
    expect(error.message).toMatch(/RPC request failed/);
    expect((error as NadBountyError).code).toBe("NETWORK");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("very-secret-key");
    expect(toNadError(new TimeoutError({ body: {}, url: RPC })).message).not.toContain("very-secret-key");
  });
  it("explains insufficient MON", () => {
    const gas = new EstimateGasExecutionError(
      new InsufficientFundsError({ cause: new BaseError("insufficient funds") }),
      { account: undefined } as never,
    );
    const error = toNadError(gas, "takeBounty") as NadBountyError;
    expect(error.code).toBe("INSUFFICIENT_FUNDS");
    expect(error.message).toMatch(/Not enough MON/);
  });
  it("keeps the SDK's own plain errors as they are, and redacts URLs from foreign ones", () => {
    const own = new Error("Wrong Monad RPC chain");
    expect(toNadError(own)).toBe(own);
    const foreign = toNadError(new Error(`connect failed to ${RPC} (ECONNREFUSED)`));
    expect(foreign.message).not.toContain("very-secret-key");
    expect(foreign.message).toContain("[url]");
    expect(redactUrls(`see ${RPC}, then https://monadscan.com/tx/0x1`)).toBe("see [url], then [url]");
  });
  it("passes through an error it already translated", () => {
    const translated = new NadBountyError("x", "paused");
    expect(toNadError(translated, "other")).toBe(translated);
  });
});

describe("inside NadBountyAgent", () => {
  beforeEach(() => resetMocks(mainnetWiring()));

  it("a failing gas estimate says what is wrong and never signs", async () => {
    mock.estimate.mockRejectedValue(revertedWith(BOUNTY_ADAPTER_V48_ABI, "ReputationGateFailed", [0n, 0n]));
    const agent = new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.owner });
    const error = await agent.pickContestWinners(1n, [0], [90]).catch((e) => e);
    expect(error).toBeInstanceOf(NadBountyError);
    expect(error.code).toBe("ReputationGateFailed");
    expect(error.message).toMatch(/^pickContestWinners: Reputation gate not met/);
    expect(mock.write).not.toHaveBeenCalled();
  });

  it("a read that reverts is translated too, without the RPC URL", async () => {
    mock.read.mockRejectedValue(revertedWith(BOUNTY_ADAPTER_V48_ABI, "WrongBountyMode", [], "contestClosedAt"));
    const error = await new NadBountyAgent({ network: "monad-mainnet" }).contestClosedAt(1n).catch((e) => e);
    expect(error.code).toBe("WrongBountyMode");
    expect(error.message).toMatch(/^contestClosedAt: /);
    mock.read.mockRejectedValue(new HttpRequestError({ url: RPC, details: "fetch failed" }));
    const network = await new NadBountyAgent({ network: "monad-mainnet" }).getBounty(1n).catch((e) => e);
    expect(network.message).not.toContain("very-secret-key");
  });

  it("a wallet without gas gets an actionable message from the send step", async () => {
    mock.write.mockRejectedValue(
      new EstimateGasExecutionError(new InsufficientFundsError({ cause: new BaseError("insufficient funds") }), {
        account: undefined,
      } as never),
    );
    const error = await new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.owner })
      .cancelBounty(1n)
      .catch((e) => e);
    expect(error.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("a reverted receipt keeps its message and points at the explorer, not the RPC", async () => {
    mock.write.mockResolvedValue(`0x${"cd".repeat(32)}`);
    mock.wait.mockResolvedValue({ status: "reverted", transactionHash: `0x${"cd".repeat(32)}` });
    const error = await new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.owner })
      .cancelBounty(1n)
      .catch((e) => e);
    expect(error.message).toMatch(/^Monad transaction reverted: 0xcd/);
    expect(error.message).toContain("https://monadscan.com/tx/0xcd");
    expect(error.message).not.toContain("rpc.monad.xyz");
  });
});
