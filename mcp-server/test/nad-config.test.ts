import { describe, it, expect, vi } from "vitest";
import { MONAD_NETWORKS } from "arcbounty-agent-sdk";
import {
  NAD_CAP_NAMES,
  NadStartupError,
  createNadAgent,
  resolveNadConfig,
  scrub,
  secretsOf,
  startupErrorMessage,
  startupLine,
  verifyRpc,
  type NadConfig,
  type RpcProbe,
} from "../src/nad-config.js";

const CANONICAL = MONAD_NETWORKS["monad-mainnet"].defaultBountyAdapter!;
const OVERRIDE = "0x9999999999999999999999999999999999999999";
const KEY = `0x${"11".repeat(32)}`;
const SIGNER_ADDRESS = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"; // the address of private key 0x11..11

function fail(env: Record<string, string>): string {
  try {
    resolveNadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(NadStartupError);
    return (error as Error).message;
  }
  throw new Error("expected resolveNadConfig to throw");
}

describe("resolveNadConfig defaults", () => {
  it("works with no configuration at all: mainnet, built-in adapter, read-only, default caps", () => {
    const config = resolveNadConfig({});
    expect(config).toMatchObject({
      network: "monad-mainnet",
      chainId: 143,
      adapter: CANONICAL,
      adapterSource: "built-in",
      customRpc: false,
      limits: { maxRewardUsdc: 20, maxSpendUsdc: 50 },
    });
    expect(config.privateKey).toBeUndefined();
    expect(config.signer).toBeUndefined();
    expect(config.rpcUrl).toBe(MONAD_NETWORKS["monad-mainnet"].rpcUrl);
  });

  it("treats blank variables as unset (a bundle host passes empty strings for unfilled settings)", () => {
    const config = resolveNadConfig({
      NAD_NETWORK: "  ",
      NAD_BOUNTY_ADAPTER_ADDRESS: "",
      NAD_RPC_URL: " ",
      NAD_PRIVATE_KEY: "",
      NAD_MAX_REWARD_USDC: "",
      NAD_MAX_SPEND_USDC: " ",
    });
    expect(config).toMatchObject({ network: "monad-mainnet", adapterSource: "built-in", customRpc: false });
    expect(config.signer).toBeUndefined();
  });

  it("derives the signer address from the key, with or without 0x", () => {
    expect(resolveNadConfig({ NAD_PRIVATE_KEY: KEY }).signer).toBe(SIGNER_ADDRESS);
    expect(resolveNadConfig({ NAD_PRIVATE_KEY: KEY.slice(2) }).privateKey).toBe(KEY);
  });

  it("keeps monad-testnet working, but only with an adapter address", () => {
    expect(fail({ NAD_NETWORK: "monad-testnet" })).toMatch(
      /no built-in NadBounty deployment.*NAD_BOUNTY_ADAPTER_ADDRESS/,
    );
    const config = resolveNadConfig({ NAD_NETWORK: "testnet", NAD_BOUNTY_ADAPTER_ADDRESS: OVERRIDE });
    expect(config).toMatchObject({
      network: "monad-testnet",
      chainId: 10143,
      adapter: OVERRIDE,
      adapterSource: "override",
    });
  });

  it("lets NAD_BOUNTY_ADAPTER_ADDRESS override the built-in adapter on mainnet", () => {
    expect(resolveNadConfig({ NAD_BOUNTY_ADAPTER_ADDRESS: OVERRIDE })).toMatchObject({
      adapter: OVERRIDE,
      adapterSource: "override",
    });
  });

  it("does not call the canonical address a custom override when it is set explicitly (older instructions did)", () => {
    expect(
      resolveNadConfig({ NAD_NETWORK: "monad-mainnet", NAD_BOUNTY_ADAPTER_ADDRESS: CANONICAL.toLowerCase() }),
    ).toMatchObject({
      adapter: CANONICAL.toLowerCase(),
      adapterSource: "built-in",
    });
  });

  it("reads the NAD_* spend caps", () => {
    expect(resolveNadConfig({ NAD_MAX_REWARD_USDC: "5", NAD_MAX_SPEND_USDC: "12.5" }).limits).toEqual({
      maxRewardUsdc: 5,
      maxSpendUsdc: 12.5,
    });
    expect(NAD_CAP_NAMES).toEqual({ reward: "NAD_MAX_REWARD_USDC", spend: "NAD_MAX_SPEND_USDC" });
  });
});

describe("resolveNadConfig errors", () => {
  it("names the variable at fault and never echoes a secret", () => {
    expect(fail({ NAD_NETWORK: "ethereum" })).toBe(
      'NAD_NETWORK="ethereum" is not supported. Use monad-mainnet (the default) or monad-testnet.',
    );
    expect(fail({ NAD_BOUNTY_ADAPTER_ADDRESS: "0x1234" })).toMatch(
      /^NAD_BOUNTY_ADAPTER_ADDRESS is not a valid address/,
    );
    expect(fail({ NAD_BOUNTY_ADAPTER_ADDRESS: "0x" + "0".repeat(40) })).toMatch(/zero address/);
    expect(fail({ NAD_RPC_URL: "ftp://example.com" })).toBe(
      "NAD_RPC_URL is not a valid http(s) URL. Its value is not shown.",
    );
    expect(fail({ NAD_RPC_URL: "not a url" })).toMatch(/NAD_RPC_URL/);
    expect(fail({ NAD_MAX_REWARD_USDC: "abc" })).toMatch(/^NAD_MAX_REWARD_USDC="abc" is not a positive number/);
    expect(fail({ NAD_MAX_SPEND_USDC: "0" })).toMatch(/NAD_MAX_SPEND_USDC/);
  });

  it("rejects a malformed key without printing it", () => {
    const bad = "this-is-not-a-key-0123456789abcdef";
    const message = fail({ NAD_PRIVATE_KEY: bad });
    expect(message).toMatch(/NAD_PRIVATE_KEY is set but is not a 32-byte hex private key/);
    expect(message).not.toContain(bad);
    expect(fail({ NAD_PRIVATE_KEY: `0x${"00".repeat(32)}` })).toMatch(/valid secp256k1/);
  });
});

describe("verifyRpc", () => {
  const config = (overrides: Partial<NadConfig> = {}): NadConfig => ({
    ...resolveNadConfig({}),
    rpcUrl: "https://rpc.private.example/SECRETPATH",
    ...overrides,
  });
  const probe = (overrides: Partial<RpcProbe> = {}): RpcProbe => ({
    chainId: async () => 143,
    codeAt: async () => "0x6080",
    ...overrides,
  });
  const message = async (c: NadConfig, p: RpcProbe) => {
    try {
      await verifyRpc(c, p, 0);
    } catch (error) {
      expect(error).toBeInstanceOf(NadStartupError);
      return (error as Error).message;
    }
    throw new Error("expected verifyRpc to throw");
  };

  it("passes when the chain id matches and the adapter has code", async () => {
    await expect(verifyRpc(config(), probe(), 0)).resolves.toBeUndefined();
  });

  it("retries once, then reports an unreachable RPC without its URL", async () => {
    const chainId = vi.fn(async () => {
      throw Object.assign(new Error("HTTP request failed. URL: https://rpc.private.example/SECRETPATH"), {
        status: 429,
      });
    });
    const text = await message(config({ customRpc: true }), probe({ chainId }));
    expect(chainId).toHaveBeenCalledTimes(2);
    expect(text).toBe(
      "Could not reach the RPC from NAD_RPC_URL (HTTP 429): network error, rate limit or timeout. Check NAD_RPC_URL and your connection.",
    );
    expect(text).not.toMatch(/SECRETPATH|https?:/);
  });

  it("suggests a dedicated endpoint when the default public RPC fails", async () => {
    const text = await message(
      config(),
      probe({
        chainId: async () => {
          throw new Error("fetch failed");
        },
      }),
    );
    expect(text).toMatch(/default public Monad RPC/);
    expect(text).toMatch(/set NAD_RPC_URL/);
  });

  it("recovers from a single hiccup", async () => {
    const chainId = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue(143);
    await expect(verifyRpc(config(), probe({ chainId }), 0)).resolves.toBeUndefined();
  });

  it("reports a wrong chain id with both numbers", async () => {
    const text = await message(config({ customRpc: true }), probe({ chainId: async () => 1 }));
    expect(text).toBe(
      "Wrong chain: the RPC from NAD_RPC_URL reports chain id 1, but monad-mainnet is chain id 143. Check NAD_RPC_URL and NAD_NETWORK.",
    );
  });

  it("reports an adapter address without code, pointing at the override when there is one", async () => {
    const built = await message(config(), probe({ codeAt: async () => "0x" }));
    expect(built).toBe(`No contract is deployed at the adapter address ${CANONICAL} on monad-mainnet.`);
    const override = await message(
      config({ adapter: OVERRIDE, adapterSource: "override" }),
      probe({ codeAt: async () => undefined }),
    );
    expect(override).toMatch(/Check NAD_BOUNTY_ADAPTER_ADDRESS\.$/);
  });
});

describe("agent construction and messages", () => {
  it("builds a mainnet agent on the canonical adapter without any override, read-only", () => {
    const agent = createNadAgent(resolveNadConfig({}));
    expect(agent.bountyAdapter).toBe(CANONICAL);
    expect(agent.network.chainId).toBe(143);
    expect(agent.address).toBe("0x0000000000000000000000000000000000000000");
  });

  it("builds a signing agent and honours the override and the custom RPC", () => {
    const agent = createNadAgent(
      resolveNadConfig({
        NAD_PRIVATE_KEY: KEY,
        NAD_BOUNTY_ADAPTER_ADDRESS: OVERRIDE,
        NAD_RPC_URL: "https://rpc.example.org",
      }),
    );
    expect(agent.address).toBe(SIGNER_ADDRESS);
    expect(agent.bountyAdapter).toBe(OVERRIDE);
    expect(agent.network.rpcUrl).toBe("https://rpc.example.org");
  });

  it("states network, adapter and mode in the startup line, with no secret", () => {
    const readOnly = startupLine(resolveNadConfig({ NAD_RPC_URL: "https://rpc.example.org/KEYPART" }));
    expect(readOnly).toBe(
      `[nadbounty] monad-mainnet (chain 143), adapter ${CANONICAL} (built-in canonical), read-only (no NAD_PRIVATE_KEY, so write tools are not registered). Gas: MON.`,
    );
    const signing = startupLine(resolveNadConfig({ NAD_PRIVATE_KEY: KEY, NAD_BOUNTY_ADAPTER_ADDRESS: OVERRIDE }));
    expect(signing).toContain(`signing as ${SIGNER_ADDRESS}`);
    expect(signing).toContain("custom override");
    expect(signing).toContain("20 USDC per bounty and 50 USDC per run");
    expect(signing).not.toContain(KEY);
    expect(signing).not.toContain(KEY.slice(2));
  });

  it("scrubs URLs, the key and the RPC from any startup error", () => {
    const env = { NAD_PRIVATE_KEY: KEY, NAD_RPC_URL: "https://rpc.private.example/SECRETPATH" };
    const secrets = secretsOf(env);
    expect(secrets).toContain(KEY);
    expect(scrub(`boom ${KEY} at https://rpc.private.example/SECRETPATH`, secrets)).toBe("boom [redacted] at [url]");
    const text = startupErrorMessage(new Error(`fetch failed ${KEY} https://rpc.private.example/SECRETPATH`), secrets);
    expect(text).toMatch(/^Unexpected error: /);
    expect(text).not.toMatch(/SECRETPATH|https?:/);
    expect(text).not.toContain(KEY.slice(2));
    expect(startupErrorMessage(new NadStartupError("NAD_NETWORK bad"), secrets)).toBe("NAD_NETWORK bad");
  });
});
