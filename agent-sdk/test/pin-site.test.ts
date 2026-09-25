import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { recoverMessageAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { pinAuthMessage, pinTextViaSite, pinTextAuto } from "../src/ipfs.js";

// A fresh throwaway key per run: nothing here may ever hold funds.
const KEY = generatePrivateKey();
const account = privateKeyToAccount(KEY);
const signer = { address: account.address, signMessage: (message: string) => account.signMessage({ message }) };

type Call = { url: string; init: RequestInit };
function recordingFetch(response: () => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, fetchImpl };
}

const ENV_KEYS = ["PINATA_JWT", "PINATA_API_KEY", "PINATA_SECRET"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("pinAuthMessage", () => {
  it("is exactly the message the site's pin route verifies (frontend/lib/wallet-auth.ts)", () => {
    expect(pinAuthMessage(account.address, 1_700_000_000)).toBe(
      `ArcBounty IPFS pin\naddress: ${account.address}\ntimestamp: 1700000000`,
    );
  });
});

describe("pinTextViaSite", () => {
  it("posts the text with a wallet signature the site can verify and returns an ipfs:// URI", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(JSON.stringify({ cid: "bafytestcid" })));

    const uri = await pinTextViaSite("hello", signer, {
      url: "https://example.test/api/ipfs/pin",
      fetchImpl,
      now: () => 1_700_000_000_123,
    });

    expect(uri).toBe("ipfs://bafytestcid");
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://example.test/api/ipfs/pin");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ content: "hello" });
    const headers = new Headers(init.headers);
    expect(headers.get("x-arc-address")).toBe(account.address);
    expect(headers.get("x-arc-timestamp")).toBe("1700000000");
    const recovered = await recoverMessageAddress({
      message: pinAuthMessage(account.address, 1_700_000_000),
      signature: headers.get("x-arc-signature") as Hex,
    });
    expect(recovered).toBe(account.address);
  });

  it("surfaces the site's status and error message when the pin is refused", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 }),
    );
    await expect(pinTextViaSite("x", signer, { url: "https://example.test/pin", fetchImpl }))
      .rejects.toThrow(/429.*Rate limit exceeded/);
  });
});

describe("pinTextAuto", () => {
  it("pins through the site when no Pinata credentials are set and the signer can sign", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(JSON.stringify({ cid: "bafysite" })));
    const uri = await pinTextAuto("body", signer, { url: "https://example.test/pin", fetchImpl });
    expect(uri).toBe("ipfs://bafysite");
    expect(calls).toHaveLength(1);
  });

  it("uses Pinata directly when credentials are set, without asking the site", async () => {
    process.env["PINATA_JWT"] = "test-jwt";
    const pinata = vi.fn(async () => new Response(JSON.stringify({ IpfsHash: "QmPinata" })));
    vi.stubGlobal("fetch", pinata);
    const { calls, fetchImpl } = recordingFetch(() => new Response(JSON.stringify({ cid: "bafysite" })));

    const uri = await pinTextAuto("body", signer, { url: "https://example.test/pin", fetchImpl });

    expect(uri).toBe("ipfs://QmPinata");
    expect(pinata).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("explains both ways out when there are no Pinata credentials and the signer cannot sign messages", async () => {
    const custodial = { address: account.address };
    await expect(pinTextAuto("body", custodial)).rejects.toThrow(/PINATA_JWT.*sign messages/s);
  });
});
