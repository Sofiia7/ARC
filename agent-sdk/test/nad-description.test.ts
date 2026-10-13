import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CONTEST_ENCRYPTION_ALGORITHM,
  contestPublicKeyOf,
  createDescription,
  parseNadDescription,
  pinContestEntry,
  serializeDescription,
} from "../src/nadDescription.js";
import { decryptContestEntry, generateContestKeypair } from "../src/contestEncryption.js";
import { DEFAULT_PIN_URL, pinAuthMessage, pinTextAuto, pinTextViaSite, pinUrlFor } from "../src/ipfs.js";
import { MONAD_NETWORKS } from "../src/constants.js";

// Throwaway key: nothing here may ever hold funds.
const account = privateKeyToAccount(`0x${"05".repeat(32)}`);
const signer = { address: account.address, signMessage: (message: string) => account.signMessage({ message }) };

function recordingFetch(cid = "bafycid") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ cid }));
  };
  return { calls, fetchImpl };
}

const ENV = ["PINATA_JWT", "PINATA_API_KEY", "PINATA_SECRET", "ARCBOUNTY_PIN_URL"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
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

describe("description document", () => {
  it("is exactly the shape the website writes for a plain bounty", () => {
    const doc = createDescription({ description: "Write a haiku about Monad\nMore detail here." });
    expect(doc).toEqual({
      version: 1,
      title: "Write a haiku about Monad",
      description: "Write a haiku about Monad\nMore detail here.",
    });
    expect(Object.keys(doc)).toEqual(["version", "title", "description"]);
    expect(JSON.parse(serializeDescription(doc))).toEqual(doc);
  });

  it("adds the contest encryption block the site reads (publicKey, keySource, algorithm, version)", async () => {
    const key = await generateContestKeypair();
    const doc = createDescription({ description: "Design a logo", contestPublicKey: key.publicKey });
    expect(doc.contestEncryption).toEqual({
      version: 1,
      algorithm: "x25519-xsalsa20-poly1305-sealedbox",
      publicKey: key.publicKey,
      keySource: "sdk-keypair-v1",
    });
    expect(Object.keys(doc.contestEncryption!)).toEqual(["version", "algorithm", "publicKey", "keySource"]);
    expect(CONTEST_ENCRYPTION_ALGORITHM).toBe("x25519-xsalsa20-poly1305-sealedbox");
    const withSource = createDescription({
      description: "x",
      contestPublicKey: key.publicKey,
      keySource: "wallet-signature-v1",
    });
    expect(withSource.contestEncryption!.keySource).toBe("wallet-signature-v1");
  });

  it("derives the title like the site (first line, 120 characters) unless one is given", () => {
    expect(createDescription({ description: `\n\n  ${"t".repeat(200)}\nrest` }).title).toBe("t".repeat(120));
    expect(createDescription({ description: "body", title: "Custom" }).title).toBe("Custom");
  });

  it("rejects empty descriptions, malformed keys and a key source without a key", () => {
    expect(() => createDescription({ description: "  " })).toThrow("non-empty");
    expect(() => createDescription({ description: "x", contestPublicKey: "AA" })).toThrow("43 characters");
    expect(() => createDescription({ description: "x", contestPublicKey: "+".repeat(43) })).toThrow("43 characters");
    expect(() => createDescription({ description: "x", keySource: "mera-prf-v1" })).toThrow(
      "together with contestPublicKey",
    );
  });

  it("parses what it wrote, legacy contestPublicKey documents, and plain text", async () => {
    const key = await generateContestKeypair();
    const parsed = parseNadDescription(
      serializeDescription(createDescription({ description: "Do it", contestPublicKey: key.publicKey })),
    );
    expect(parsed.title).toBe("Do it");
    expect(contestPublicKeyOf(parsed)).toBe(key.publicKey);
    const legacy = parseNadDescription(
      JSON.stringify({ name: "demo", description: "Old", contestPublicKey: key.publicKey }),
    );
    expect(contestPublicKeyOf(legacy)).toBe(key.publicKey);
    expect(parseNadDescription("# Heading\nplain")).toEqual({ title: "# Heading", description: "# Heading\nplain" });
    expect(parseNadDescription("[1,2]").description).toBe("[1,2]");
    expect(contestPublicKeyOf(parseNadDescription(JSON.stringify({ description: "no key" })))).toBeUndefined();
  });
});

describe("pinContestEntry", () => {
  it("encrypts to the poster's key and pins only the sealed envelope", async () => {
    const key = await generateContestKeypair();
    const { calls, fetchImpl } = recordingFetch("bafyentry");
    const secret = "my winning solution, for the poster only";
    const description = createDescription({ description: "Contest", contestPublicKey: key.publicKey });
    const uri = await pinContestEntry(secret, description, signer, { fetchImpl });
    expect(uri).toBe("ipfs://bafyentry");
    const sent = JSON.parse(String(calls[0]!.init.body)).content as string;
    expect(sent).not.toContain(secret);
    const envelope = JSON.parse(sent);
    expect(envelope).toMatchObject({
      version: 1,
      algorithm: "x25519-xsalsa20-poly1305-sealedbox",
      recipientPublicKey: key.publicKey,
    });
    expect(await decryptContestEntry(envelope, key)).toBe(secret);
  });

  it("accepts a bare public key and refuses a description without one", async () => {
    const key = await generateContestKeypair();
    const { fetchImpl } = recordingFetch();
    await expect(pinContestEntry("x", key.publicKey, signer, { fetchImpl })).resolves.toBe("ipfs://bafycid");
    await expect(
      pinContestEntry("x", createDescription({ description: "plain bounty" }), signer, { fetchImpl }),
    ).rejects.toThrow("no contest encryption key");
  });
});

describe("pin route defaults per network", () => {
  it("defaults to the Monad site of each network, and to ArcBounty without one", () => {
    expect(pinUrlFor("monad-mainnet")).toBe("https://nadbounty.app/api/ipfs/pin");
    expect(pinUrlFor("monad-testnet")).toBe("https://nadbounty-testnet.vercel.app/api/ipfs/pin");
    expect(pinUrlFor()).toBe(DEFAULT_PIN_URL);
    expect(DEFAULT_PIN_URL).toBe("https://arcbounty.app/api/ipfs/pin");
    expect(MONAD_NETWORKS["monad-mainnet"].pinUrl).toBe(pinUrlFor("monad-mainnet"));
  });

  it("posts to the network's route with the request shape the site's route verifies", async () => {
    const routes = [
      ["monad-mainnet", "https://nadbounty.app/api/ipfs/pin"],
      ["monad-testnet", "https://nadbounty-testnet.vercel.app/api/ipfs/pin"],
    ] as const;
    for (const [network, url] of routes) {
      const { calls, fetchImpl } = recordingFetch();
      await pinTextViaSite("hello", signer, { network, fetchImpl, now: () => 1_700_000_000_000 });
      expect(calls[0]!.url).toBe(url);
      const headers = new Headers(calls[0]!.init.headers);
      expect(calls[0]!.init.method).toBe("POST");
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: "hello" });
      expect(headers.get("x-arc-address")).toBe(account.address);
      expect(headers.get("x-arc-timestamp")).toBe("1700000000");
      const recovered = await recoverMessageAddress({
        message: pinAuthMessage(account.address, 1_700_000_000),
        signature: headers.get("x-arc-signature") as Hex,
      });
      expect(recovered).toBe(account.address);
    }
  });

  it("keeps the same override hooks: an explicit url, then ARCBOUNTY_PIN_URL, beat the network default", async () => {
    const explicit = recordingFetch();
    await pinTextViaSite("a", signer, {
      network: "monad-mainnet",
      url: "https://example.test/pin",
      fetchImpl: explicit.fetchImpl,
    });
    expect(explicit.calls[0]!.url).toBe("https://example.test/pin");
    process.env["ARCBOUNTY_PIN_URL"] = "https://env.test/pin";
    const env = recordingFetch();
    await pinTextViaSite("b", signer, { network: "monad-mainnet", fetchImpl: env.fetchImpl });
    expect(env.calls[0]!.url).toBe("https://env.test/pin");
    await pinTextViaSite("c", signer, {
      network: "monad-mainnet",
      url: "https://example.test/pin",
      fetchImpl: env.fetchImpl,
    });
    expect(env.calls[1]!.url).toBe("https://example.test/pin");
  });

  it("is unchanged for existing callers that pass no network", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await pinTextAuto("body", signer, { fetchImpl });
    expect(calls[0]!.url).toBe(DEFAULT_PIN_URL);
  });

  it("still prefers the caller's own Pinata credentials over any site", async () => {
    process.env["PINATA_JWT"] = "test-jwt";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ IpfsHash: "QmOwn" }))),
    );
    const { calls, fetchImpl } = recordingFetch();
    expect(await pinTextAuto("body", signer, { network: "monad-mainnet", fetchImpl })).toBe("ipfs://QmOwn");
    expect(calls).toHaveLength(0);
  });
});
