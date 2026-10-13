import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  recoverTypedDataAddress,
} from "viem";
import { NadBountyAgent } from "../src/NadBountyAgent.js";
import { MONAD_NETWORKS } from "../src/constants.js";
import { MONAD_IDENTITY_REGISTRY_ABI, agentWalletTypedData } from "../src/nadIdentity.js";
import { NadBountyError } from "../src/nadErrors.js";
import { THROWAWAY_KEYS, ZERO, addresses, hash, mainnetWiring, mock, resetMocks, state } from "./helpers/nadMock.js";

vi.mock("viem", async (importOriginal) => (await import("./helpers/nadMock.js")).viemMock(await importOriginal()));
vi.mock("../src/signers/viemSigner.js", async () => (await import("./helpers/nadMock.js")).signerMock());

const REGISTRY = MONAD_NETWORKS["monad-mainnet"].identity;
const owner = () => new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.owner });
const working = () => new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.worker });

const registeredLog = (agentId: bigint, ownerAddress: `0x${string}`, uri = "", address: `0x${string}` = REGISTRY) => ({
  address,
  topics: encodeEventTopics({
    abi: MONAD_IDENTITY_REGISTRY_ABI,
    eventName: "Registered",
    args: { agentId, owner: ownerAddress },
  }),
  data: encodeAbiParameters([{ type: "string" }], [uri]),
});
const mintLog = (tokenId: bigint, to: `0x${string}`) => ({
  address: REGISTRY,
  topics: encodeEventTopics({
    abi: MONAD_IDENTITY_REGISTRY_ABI,
    eventName: "Transfer",
    args: { from: ZERO, to, tokenId },
  }),
  data: "0x",
});
const receiptWith = (logs: unknown[]) => ({ status: "success", transactionHash: hash, logs });

beforeEach(() => resetMocks({ ...mainnetWiring(), ownerOf: addresses.owner, getAgentWallet: addresses.owner }));

describe("registerIdentity", () => {
  it("calls register() without a URI and reads the agentId from the Registered event", async () => {
    mock.estimate.mockResolvedValue(200_000n);
    mock.wait.mockResolvedValue(
      receiptWith([mintLog(10388n, addresses.owner), registeredLog(10388n, addresses.owner)]),
    );
    const result = await owner().registerIdentity();
    expect(result.agentId).toBe(10388n);
    expect(result.hash).toBe(hash);
    expect(mock.estimate).toHaveBeenCalledWith(
      expect.objectContaining({ address: REGISTRY, functionName: "register", args: [] }),
    );
    expect(mock.write).toHaveBeenCalledWith(
      expect.objectContaining({ address: REGISTRY, functionName: "register", args: [], gas: 300_000n }),
    );
  });

  it("registers with an agent URI when given one", async () => {
    mock.wait.mockResolvedValue(receiptWith([registeredLog(7n, addresses.owner, "ipfs://card")]));
    expect((await owner().registerIdentity("ipfs://card")).agentId).toBe(7n);
    expect(mock.write).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "register", args: ["ipfs://card"] }),
    );
  });

  it("falls back to the mint Transfer when there is no Registered event", async () => {
    mock.wait.mockResolvedValue(receiptWith([mintLog(55n, addresses.owner)]));
    expect((await owner().registerIdentity()).agentId).toBe(55n);
  });

  it("ignores events for another owner or from another contract, and fails loudly without one", async () => {
    mock.wait.mockResolvedValue(
      receiptWith([
        registeredLog(1n, addresses.stranger),
        registeredLog(2n, addresses.owner, "", "0x0000000000000000000000000000000000000bad"),
        mintLog(3n, addresses.stranger),
      ]),
    );
    await expect(owner().registerIdentity()).rejects.toThrow("Missing Registered event");
  });

  it("does not need the adapter wiring, only the right chain", async () => {
    mock.wait.mockResolvedValue(receiptWith([registeredLog(9n, addresses.owner)]));
    state.reads = {}; // any adapter read would now throw
    expect((await owner().registerIdentity()).agentId).toBe(9n);
    mock.chain.mockResolvedValue(10143);
    await expect(owner().registerIdentity()).rejects.toThrow("Wrong Monad RPC chain");
  });

  it("needs a private key", async () => {
    await expect(new NadBountyAgent({ network: "monad-mainnet" }).registerIdentity()).rejects.toThrow(
      "private key is required",
    );
    expect(mock.write).not.toHaveBeenCalled();
  });
});

describe("getIdentity", () => {
  it("returns the owner and the current working wallet", async () => {
    state.reads["ownerOf"] = addresses.owner;
    state.reads["getAgentWallet"] = addresses.worker;
    expect(await new NadBountyAgent({ network: "monad-mainnet" }).getIdentity(10388n)).toEqual({
      owner: addresses.owner,
      workingWallet: addresses.worker,
    });
    expect(mock.multicall).toHaveBeenCalledTimes(1);
    expect(mock.read.mock.calls[0]![0]).toMatchObject({ address: REGISTRY, functionName: "ownerOf", args: [10388n] });
  });

  it("explains a missing agentId instead of leaking a raw viem blob", async () => {
    const data = encodeErrorResult({
      abi: MONAD_IDENTITY_REGISTRY_ABI,
      errorName: "ERC721NonexistentToken",
      args: [99n],
    });
    const revert = new ContractFunctionRevertedError({
      abi: MONAD_IDENTITY_REGISTRY_ABI,
      data,
      functionName: "ownerOf",
    });
    mock.multicall.mockRejectedValue(
      new ContractFunctionExecutionError(revert, {
        abi: MONAD_IDENTITY_REGISTRY_ABI,
        functionName: "ownerOf",
        args: [99n],
      }),
    );
    const error = await new NadBountyAgent({ network: "monad-mainnet" }).getIdentity(99n).catch((e) => e);
    expect(error).toBeInstanceOf(NadBountyError);
    expect(error.code).toBe("ERC721NonexistentToken");
    expect(error.message).toMatch(/agentId 99 does not exist/);
  });
});

describe("working wallet: two steps", () => {
  it("step 1: the working wallet signs the exact AgentWalletSet consent the registry verifies", async () => {
    const consent = await working().signAgentWalletConsent({ agentId: 10388n, owner: addresses.owner });
    expect(consent).toMatchObject({
      agentId: 10388n,
      newWallet: addresses.worker,
      owner: addresses.owner,
      deadline: state.now + 300n,
    });
    const typed = agentWalletTypedData({
      chainId: 143,
      registry: REGISTRY,
      agentId: 10388n,
      newWallet: addresses.worker,
      owner: addresses.owner,
      deadline: consent.deadline,
    });
    expect(typed.domain).toEqual({
      name: "ERC8004IdentityRegistry",
      version: "1",
      chainId: 143,
      verifyingContract: REGISTRY,
    });
    expect(typed.types.AgentWalletSet.map((field) => `${field.type} ${field.name}`)).toEqual([
      "uint256 agentId",
      "address newWallet",
      "address owner",
      "uint256 deadline",
    ]);
    expect(await recoverTypedDataAddress({ ...typed, signature: consent.signature })).toBe(addresses.worker);
  });

  it("refuses a deadline the registry would reject, and bad inputs", async () => {
    const agent = working();
    await expect(
      agent.signAgentWalletConsent({ agentId: 1n, owner: addresses.owner, deadline: state.now + 301n }),
    ).rejects.toThrow("more than 5 minutes");
    await expect(
      agent.signAgentWalletConsent({ agentId: 1n, owner: addresses.owner, deadline: state.now }),
    ).rejects.toThrow("already in the past");
    await expect(agent.signAgentWalletConsent({ agentId: 0n, owner: addresses.owner })).rejects.toThrow(
      "positive bigint",
    );
    await expect(agent.signAgentWalletConsent({ agentId: 1n, owner: ZERO })).rejects.toThrow("identity owner");
    await expect(
      new NadBountyAgent({ network: "monad-mainnet" }).signAgentWalletConsent({ agentId: 1n, owner: addresses.owner }),
    ).rejects.toThrow("private key is required");
  });

  it("step 2: the owner submits it with the arguments in the registry's order", async () => {
    mock.estimate.mockResolvedValue(125_591n);
    const consent = await working().signAgentWalletConsent({ agentId: 10388n, owner: addresses.owner });
    await owner().setAgentWallet(10388n, consent);
    expect(mock.write).toHaveBeenCalledWith({
      address: REGISTRY,
      abi: MONAD_IDENTITY_REGISTRY_ABI,
      functionName: "setAgentWallet",
      args: [10388n, addresses.worker, consent.deadline, consent.signature],
      gas: 188_387n,
    });
  });

  it("setWorkingWallet is the same call", async () => {
    const consent = await working().signAgentWalletConsent({ agentId: 10388n, owner: addresses.owner });
    await owner().setWorkingWallet(10388n, consent);
    expect(mock.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "setAgentWallet" }));
  });

  it("will not send a consent that is for someone else, for another identity, from a non-owner, or expired", async () => {
    const consent = await working().signAgentWalletConsent({ agentId: 10388n, owner: addresses.owner });
    await expect(owner().setAgentWallet(1n, consent)).rejects.toThrow("different agentId");
    await expect(working().setAgentWallet(10388n, consent)).rejects.toThrow(/names 0x.* as owner/);
    state.reads["ownerOf"] = addresses.stranger;
    await expect(owner().setAgentWallet(10388n, consent)).rejects.toThrow("Only the identity owner");
    state.reads["ownerOf"] = addresses.owner;
    state.now = consent.deadline + 1n;
    await expect(owner().setAgentWallet(10388n, consent)).rejects.toThrow("expired");
    expect(mock.write).not.toHaveBeenCalled();
  });

  it("owner can remove the working wallet", async () => {
    await owner().unsetAgentWallet(10388n);
    expect(mock.write).toHaveBeenCalledWith(
      expect.objectContaining({ address: REGISTRY, functionName: "unsetAgentWallet", args: [10388n] }),
    );
    state.reads["ownerOf"] = addresses.stranger;
    mock.write.mockClear();
    await expect(owner().unsetAgentWallet(10388n)).rejects.toThrow("Only the identity owner");
    expect(mock.write).not.toHaveBeenCalled();
  });
});
