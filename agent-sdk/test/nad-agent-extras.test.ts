import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { BOUNTY_ADAPTER_V48_ABI } from "../src/abi-v48.js";
import { NadBountyAgent, type NadBountyCreateParams } from "../src/NadBountyAgent.js";
import { validateNadCreateParams } from "../src/nadParams.js";
import { createDescription, serializeDescription } from "../src/nadDescription.js";
import { decryptContestEntry, generateContestKeypair } from "../src/contestEncryption.js";
import { NadBountyError } from "../src/nadErrors.js";
import { THROWAWAY_KEYS, addresses, mainnetWiring, mock, resetMocks, state } from "./helpers/nadMock.js";

vi.mock("viem", async (importOriginal) => (await import("./helpers/nadMock.js")).viemMock(await importOriginal()));
vi.mock("../src/signers/viemSigner.js", async () => (await import("./helpers/nadMock.js")).signerMock());

const CANONICAL = "0x5C38F98Fb3F3BA3eB8206Cb653eeDC8C159E1bE4";
const NOW = BigInt(Math.floor(Date.now() / 1000));
const base: NadBountyCreateParams = {
  provider: "0x0000000000000000000000000000000000000000",
  reward: 5_000_000n,
  deadline: NOW + 7n * 86_400n,
  ipfsDescHash: "ipfs://bafydescription",
  category: "dev",
  tags: ["monad"],
  agentOnly: false,
  humanOnly: false,
  requireWorkerBond: false,
  contest: false,
  maxEntries: 0,
  winners: 0,
  minJobs: 0n,
  minAvgScore: 0,
};
const worker = () => new NadBountyAgent({ network: "monad-mainnet", privateKey: THROWAWAY_KEYS.worker });

const ENV = ["PINATA_JWT", "PINATA_API_KEY", "PINATA_SECRET", "ARCBOUNTY_PIN_URL"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  resetMocks({ ...mainnetWiring(), allowance: 1_000_000_000n });
  for (const key of ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

describe("validateNadCreateParams", () => {
  const check = (patch: Partial<NadBountyCreateParams>) => () => validateNadCreateParams({ ...base, ...patch }, NOW);

  it("accepts the shapes the website posts", () => {
    expect(check({})).not.toThrow();
    expect(check({ contest: true, maxEntries: 25, winners: 25, agentOnly: true })).not.toThrow();
    expect(check({ requireWorkerBond: true, deadline: NOW + 3n * 86_400n })).not.toThrow();
    expect(check({ category: "other", tags: [], minAvgScore: 100 })).not.toThrow();
  });
  it("catches a duration or milliseconds passed as the deadline", () => {
    expect(check({ deadline: 86_400n })).toThrow(/not in the future.*not a duration/);
    expect(check({ deadline: NOW })).toThrow(/not in the future/);
    expect(check({ deadline: NOW * 1000n })).toThrow(/milliseconds/);
  });
  it("catches a reward that is not USDC base units", () => {
    expect(check({ reward: 5 as never })).toThrow(/bigint in USDC base units/);
    expect(check({ reward: 999_999n })).toThrow(/below the 1 USDC minimum/);
    expect(check({ deadline: 5 as never })).toThrow(/bigint/);
  });
  it("mirrors the contract's category, tag, CID and score rules", () => {
    expect(check({ category: "crypto" })).toThrow(/dev, design, content, data, other/);
    expect(check({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).toThrow(/at most 10 tags/);
    expect(check({ tags: [""] })).toThrow(/1-32 bytes/);
    expect(check({ tags: ["x".repeat(33)] })).toThrow(/1-32 bytes/);
    expect(check({ ipfsDescHash: "" })).toThrow(/1-96 bytes/);
    expect(check({ ipfsDescHash: `ipfs://${"a".repeat(90)}` })).toThrow(/1-96 bytes/);
    expect(check({ agentOnly: true, humanOnly: true })).toThrow(/cannot both be true/);
    expect(check({ minAvgScore: 101 })).toThrow(/0 to 100/);
  });
  it("mirrors the contest and bond rules", () => {
    expect(check({ contest: true, maxEntries: 0, winners: 1 })).toThrow(/maxEntries from 1 to 25/);
    expect(check({ contest: true, maxEntries: 26, winners: 1 })).toThrow(/maxEntries from 1 to 25/);
    expect(check({ contest: true, maxEntries: 3, winners: 4 })).toThrow(/winners from 1 to maxEntries/);
    expect(check({ contest: true, maxEntries: 3, winners: 0 })).toThrow(/winners from 1 to maxEntries/);
    expect(check({ contest: true, maxEntries: 3, winners: 1, requireWorkerBond: true })).toThrow(
      /cannot require a worker bond/,
    );
    expect(check({ requireWorkerBond: true, deadline: NOW + 3600n })).toThrow(/at least 24 hours/);
  });
  it("throws readable NadBountyErrors", () => {
    const error = (() => {
      try {
        validateNadCreateParams({ ...base, deadline: 1n }, NOW);
      } catch (e) {
        return e;
      }
    })() as NadBountyError;
    expect(error).toBeInstanceOf(NadBountyError);
    expect(error.code).toBe("INVALID_PARAMS");
  });
});

describe("createBounty", () => {
  it("rejects a bad deadline before spending gas on the USDC approval", async () => {
    state.reads["allowance"] = 0n;
    await expect(worker().createBounty({ ...base, deadline: 86_400n })).rejects.toThrow(
      /absolute unix timestamp in seconds/,
    );
    expect(mock.read).not.toHaveBeenCalled();
    expect(mock.write).not.toHaveBeenCalled();
  });

  it("creates a bounty on the built-in mainnet adapter and decodes the job id from it", async () => {
    const topics = encodeEventTopics({
      abi: BOUNTY_ADAPTER_V48_ABI,
      eventName: "BountyCreated",
      args: { jobId: 9n, poster: addresses.worker },
    });
    const data = encodeAbiParameters(
      [{ type: "uint256" }, { type: "string" }, { type: "uint256" }],
      [base.reward, base.category, base.deadline],
    );
    mock.wait.mockResolvedValue({
      status: "success",
      transactionHash: `0x${"ab".repeat(32)}`,
      logs: [{ address: CANONICAL, topics, data }],
    });
    const created = await worker().createBounty(base);
    expect(created.jobId).toBe(9n);
    expect(mock.write).toHaveBeenCalledWith(
      expect.objectContaining({ address: CANONICAL, functionName: "createBounty" }),
    );
  });
});

describe("disputeBounty", () => {
  it("is the single-taker dispute path, with the contract's argument order", async () => {
    await worker().disputeBounty(5n, "ipfs://reason");
    expect(mock.write).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "disputeBounty", args: [5n, "ipfs://reason"] }),
    );
  });
});

describe("pinning through the agent", () => {
  const siteFetch = (cid = "bafypinned") => {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
      calls,
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ cid }));
      },
    };
  };

  it("pins through nadbounty.app on mainnet, signed by the agent's wallet", async () => {
    const { calls, fetchImpl } = siteFetch();
    expect(await worker().pin("# result", { fetchImpl })).toBe("ipfs://bafypinned");
    expect(calls[0]!.url).toBe("https://nadbounty.app/api/ipfs/pin");
    expect(new Headers(calls[0]!.init.headers).get("x-arc-address")).toBe(addresses.worker);
  });
  it("pins through the testnet site on testnet", async () => {
    const { calls, fetchImpl } = siteFetch();
    await new NadBountyAgent({
      network: "monad-testnet",
      bountyAdapterAddress: "0x0000000000000000000000000000000000000048",
      privateKey: THROWAWAY_KEYS.worker,
    }).pin("x", { fetchImpl });
    expect(calls[0]!.url).toBe("https://nadbounty-testnet.vercel.app/api/ipfs/pin");
  });
  it("lets a url option override the default, and explains when nothing can sign", async () => {
    const { calls, fetchImpl } = siteFetch();
    await worker().pin("x", { fetchImpl, url: "https://example.test/pin" });
    expect(calls[0]!.url).toBe("https://example.test/pin");
    await expect(new NadBountyAgent({ network: "monad-mainnet" }).pin("x", { fetchImpl })).rejects.toThrow(
      /Cannot pin to IPFS/,
    );
  });
  it("builds and pins the description document the site reads", async () => {
    const { calls, fetchImpl } = siteFetch();
    const key = await generateContestKeypair();
    const uri = await worker().pinDescription(
      { description: "Build a bot\nDetails", contestPublicKey: key.publicKey },
      { fetchImpl },
    );
    expect(uri).toBe("ipfs://bafypinned");
    expect(JSON.parse(JSON.parse(String(calls[0]!.init.body)).content)).toEqual({
      version: 1,
      title: "Build a bot",
      description: "Build a bot\nDetails",
      contestEncryption: {
        version: 1,
        algorithm: "x25519-xsalsa20-poly1305-sealedbox",
        publicKey: key.publicKey,
        keySource: "sdk-keypair-v1",
      },
    });
  });

  it("reads a bounty's description back from IPFS", async () => {
    state.reads["getBountyMeta"] = { jobId: 3n, ipfsDescHash: "ipfs://bafydesc" };
    const doc = serializeDescription(createDescription({ description: "Hello world" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(doc)),
    );
    expect(await worker().getBountyDescription(3n)).toEqual({ title: "Hello world", description: "Hello world" });
  });

  it("encrypts a contest entry to the key in the bounty's description and pins only ciphertext", async () => {
    const key = await generateContestKeypair();
    state.reads["getBountyMeta"] = { jobId: 3n, ipfsDescHash: "ipfs://bafydesc" };
    const doc = serializeDescription(createDescription({ description: "Contest", contestPublicKey: key.publicKey }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(doc)),
    );
    const { calls, fetchImpl } = siteFetch("bafyentry");
    const uri = await worker().pinContestEntry(3n, "secret answer", { fetchImpl });
    expect(uri).toBe("ipfs://bafyentry");
    const sent = JSON.parse(String(calls[0]!.init.body)).content as string;
    expect(sent).not.toContain("secret answer");
    expect(await decryptContestEntry(JSON.parse(sent), key)).toBe("secret answer");
  });

  it("refuses to treat a plain bounty as an encrypted contest", async () => {
    state.reads["getBountyMeta"] = { jobId: 3n, ipfsDescHash: "ipfs://bafydesc" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(serializeDescription(createDescription({ description: "plain" })))),
    );
    await expect(worker().pinContestEntry(3n, "x", { fetchImpl: siteFetch().fetchImpl })).rejects.toThrow(
      "no contest encryption key",
    );
  });
});
