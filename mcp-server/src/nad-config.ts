import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_NETWORKS, NadBountyAgent, redactUrls, toNadError, type MonadNetworkName } from "arcbounty-agent-sdk";
import { readSpendLimits, type CapNames, type SpendLimits } from "./limits.js";

/**
 * Startup configuration of the Monad (NadBounty) MCP server: reading and validating the environment, checking the
 * RPC, building the agent and describing failures. Kept apart from nad-cli.ts, which starts the process as soon as it
 * is imported, so that every message here can be tested without starting anything.
 */

export type NadEnv = Record<string, string | undefined>;

/** The variables that carry the spend caps; they appear in error messages shown to the operator and the agent. */
export const NAD_CAP_NAMES: CapNames = { reward: "NAD_MAX_REWARD_USDC", spend: "NAD_MAX_SPEND_USDC" };

/** Zero configuration means the live deployment: mainnet with the SDK's built-in canonical adapter. */
export const DEFAULT_NAD_NETWORK: MonadNetworkName = "monad-mainnet";

const NETWORK_ALIASES: Record<string, MonadNetworkName> = {
  "monad-mainnet": "monad-mainnet",
  "monad-testnet": "monad-testnet",
  mainnet: "monad-mainnet",
  testnet: "monad-testnet",
};

/** A startup problem whose message is safe to print: it never contains an RPC URL or a key. */
export class NadStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NadStartupError";
  }
}

export type NadConfig = {
  network: MonadNetworkName;
  chainId: number;
  /** The adapter the server talks to. */
  adapter: Address;
  /** Whether that is the SDK's built-in canonical deployment or the NAD_BOUNTY_ADAPTER_ADDRESS override. */
  adapterSource: "built-in" | "override";
  /** The effective RPC endpoint. Never printed. */
  rpcUrl: string;
  customRpc: boolean;
  privateKey?: Hex;
  /** Address of `privateKey`, derived at startup. */
  signer?: Address;
  limits: SpendLimits;
};

const blank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** A short, printable echo of a value the operator typed (never used for secrets). */
const echo = (value: string): string => JSON.stringify(value.replace(/[^\x20-\x7e]/g, "?").slice(0, 40));

/** Read and validate the environment. Throws a {@link NadStartupError} naming the variable at fault. */
export function resolveNadConfig(env: NadEnv): NadConfig {
  const rawNetwork = blank(env["NAD_NETWORK"]);
  const network = rawNetwork === undefined ? DEFAULT_NAD_NETWORK : NETWORK_ALIASES[rawNetwork.toLowerCase()];
  if (!network) {
    throw new NadStartupError(
      `NAD_NETWORK=${echo(rawNetwork!)} is not supported. Use monad-mainnet (the default) or monad-testnet.`,
    );
  }
  const config = MONAD_NETWORKS[network];

  const rawAdapter = blank(env["NAD_BOUNTY_ADAPTER_ADDRESS"]);
  let adapter: Address;
  let adapterSource: NadConfig["adapterSource"];
  if (rawAdapter !== undefined) {
    if (!isAddress(rawAdapter)) {
      throw new NadStartupError(
        "NAD_BOUNTY_ADAPTER_ADDRESS is not a valid address: expected 0x followed by 40 hex characters " +
          "(a mixed-case address must have a correct checksum; the all-lowercase form is always accepted).",
      );
    }
    if (/^0x0{40}$/i.test(rawAdapter)) {
      throw new NadStartupError("NAD_BOUNTY_ADAPTER_ADDRESS is the zero address. Set the V4.8 adapter or unset it.");
    }
    adapter = rawAdapter as Address;
    // Setting the canonical address explicitly (older READMEs said to) is not a custom adapter.
    adapterSource = adapter.toLowerCase() === config.defaultBountyAdapter?.toLowerCase() ? "built-in" : "override";
  } else if (config.defaultBountyAdapter) {
    adapter = config.defaultBountyAdapter;
    adapterSource = "built-in";
  } else {
    throw new NadStartupError(
      `${network} has no built-in NadBounty deployment: set NAD_BOUNTY_ADAPTER_ADDRESS to the V4.8 adapter address, ` +
        "or use monad-mainnet (the default), which needs no configuration.",
    );
  }

  const rawRpc = blank(env["NAD_RPC_URL"]);
  if (rawRpc !== undefined) {
    let protocol = "";
    try {
      protocol = new URL(rawRpc).protocol;
    } catch {
      /* reported below */
    }
    if (protocol !== "http:" && protocol !== "https:") {
      throw new NadStartupError("NAD_RPC_URL is not a valid http(s) URL. Its value is not shown.");
    }
  }

  let privateKey: Hex | undefined;
  let signer: Address | undefined;
  const rawKey = blank(env["NAD_PRIVATE_KEY"]);
  if (rawKey !== undefined) {
    const hex = rawKey.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new NadStartupError(
        "NAD_PRIVATE_KEY is set but is not a 32-byte hex private key (64 hex characters, with or without 0x). " +
          "Its value is not shown. Unset it to run read-only.",
      );
    }
    privateKey = `0x${hex}` as Hex;
    try {
      signer = privateKeyToAccount(privateKey).address;
    } catch {
      throw new NadStartupError("NAD_PRIVATE_KEY is not a valid secp256k1 private key. Its value is not shown.");
    }
  }

  let limits: SpendLimits;
  try {
    limits = readSpendLimits(env, NAD_CAP_NAMES);
  } catch (error) {
    throw new NadStartupError(error instanceof Error ? error.message.slice(0, 160) : "Invalid spend cap");
  }

  return {
    network,
    chainId: config.chainId,
    adapter,
    adapterSource,
    rpcUrl: rawRpc ?? config.rpcUrl,
    customRpc: rawRpc !== undefined,
    ...(privateKey ? { privateKey, signer } : {}),
    limits,
  };
}

/** The values that must never reach stderr or a tool result: the key (with and without 0x) and the RPC URL. */
export function secretsOf(env: NadEnv): string[] {
  const out: string[] = [];
  const key = blank(env["NAD_PRIVATE_KEY"]);
  if (key) out.push(key, key.replace(/^0x/i, ""));
  const rpc = blank(env["NAD_RPC_URL"]);
  if (rpc) out.push(rpc);
  return out.filter((secret) => secret.length >= 8);
}

/** Remove URLs and the given secrets from a message. */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = redactUrls(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  return out;
}

/** What the startup check needs from the node; replaceable in tests. */
export type RpcProbe = {
  chainId(): Promise<number>;
  codeAt(address: Address): Promise<string | undefined>;
};

export function rpcProbe(rpcUrl: string): RpcProbe {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }) });
  return {
    chainId: () => client.getChainId(),
    codeAt: async (address) => client.getCode({ address }),
  };
}

/** The HTTP status somewhere in a viem error chain, if there is one. */
function httpStatus(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const status = (current as { status?: unknown }).status;
    if (typeof status === "number") return status;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Check, before the server starts, that the RPC answers, is on the expected chain and that the adapter has code.
 * One retry covers a momentary public-RPC hiccup. Failures become {@link NadStartupError}s that name the cause and
 * never include the RPC URL.
 */
export async function verifyRpc(
  config: NadConfig,
  probe: RpcProbe = rpcProbe(config.rpcUrl),
  retryDelayMs = 750,
): Promise<void> {
  const where = config.customRpc ? "the RPC from NAD_RPC_URL" : "the default public Monad RPC";
  const unreachable = (error: unknown) => {
    const status = httpStatus(error);
    return new NadStartupError(
      `Could not reach ${where}${status ? ` (HTTP ${status})` : ""}: network error, rate limit or timeout. ` +
        (config.customRpc
          ? "Check NAD_RPC_URL and your connection."
          : "Check your connection, or set NAD_RPC_URL to a dedicated endpoint; the public one is rate limited."),
    );
  };

  let chainId: number;
  try {
    chainId = await probe.chainId();
  } catch (first) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      chainId = await probe.chainId();
    } catch (second) {
      throw unreachable(second ?? first);
    }
  }
  if (chainId !== config.chainId) {
    throw new NadStartupError(
      `Wrong chain: ${where} reports chain id ${chainId}, but ${config.network} is chain id ${config.chainId}. ` +
        "Check NAD_RPC_URL and NAD_NETWORK.",
    );
  }

  let code: string | undefined;
  try {
    code = await probe.codeAt(config.adapter);
  } catch (error) {
    throw unreachable(error);
  }
  if (!code || code === "0x") {
    throw new NadStartupError(
      `No contract is deployed at the adapter address ${config.adapter} on ${config.network}.` +
        (config.adapterSource === "override" ? " Check NAD_BOUNTY_ADAPTER_ADDRESS." : ""),
    );
  }
}

/** Build the SDK client. Only an explicit override is passed on: the built-in adapter is the SDK's own default. */
export function createNadAgent(config: NadConfig): NadBountyAgent {
  try {
    return new NadBountyAgent({
      network: config.network,
      ...(config.adapterSource === "override" ? { bountyAdapterAddress: config.adapter } : {}),
      ...(config.customRpc ? { rpcUrl: config.rpcUrl } : {}),
      ...(config.privateKey ? { privateKey: config.privateKey } : {}),
    });
  } catch (error) {
    const secrets = [config.privateKey, config.rpcUrl].filter((value): value is string => !!value);
    const text = scrub(error instanceof Error ? error.message : String(error), secrets);
    throw new NadStartupError(
      `Could not create the Monad client: ${text.replace(/0x[0-9a-fA-F]{64}/g, "[redacted]").slice(0, 300)}`,
    );
  }
}

/** The one-line startup banner (stderr): network, adapter and whether writes are possible. Contains no secret. */
export function startupLine(config: NadConfig, tag = "[nadbounty]"): string {
  const adapter = `adapter ${config.adapter} (${config.adapterSource === "built-in" ? "built-in canonical" : "custom override"})`;
  const mode = config.signer
    ? `signing as ${config.signer}; spend caps ${config.limits.maxRewardUsdc} USDC per bounty and ${config.limits.maxSpendUsdc} USDC per run`
    : "read-only (no NAD_PRIVATE_KEY, so write tools are not registered)";
  return `${tag} ${config.network} (chain ${config.chainId}), ${adapter}, ${mode}. Gas: MON.`;
}

/** The text printed after "Startup failed:". Precise for configuration problems, scrubbed for anything else. */
export function startupErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  if (error instanceof NadStartupError) return scrub(error.message, secrets);
  let text: string;
  try {
    text = toNadError(error).message;
  } catch {
    text = String(error);
  }
  return `Unexpected error: ${scrub(text, secrets)
    .replace(/0x[0-9a-fA-F]{64}/g, "[redacted]")
    .slice(0, 300)}`;
}

export const NAD_USAGE = `nadbounty-mcp: MCP server for NadBounty on Monad (stdio).

Usage: nadbounty-mcp [--help] [--version]

With no configuration it reads the live Monad mainnet deployment. Environment variables:
  NAD_PRIVATE_KEY           Signing key (hex). Without it the server is read-only and registers no write tools.
  NAD_NETWORK               monad-mainnet (default) or monad-testnet (then NAD_BOUNTY_ADAPTER_ADDRESS is required).
  NAD_BOUNTY_ADAPTER_ADDRESS  Optional adapter override.
  NAD_RPC_URL               Optional RPC endpoint (the public one is rate limited).
  NAD_MAX_REWARD_USDC       Largest reward post_bounty accepts for one bounty (default 20).
  NAD_MAX_SPEND_USDC        Most post_bounty may lock in total during one run (default 50).

Gas is paid in MON, rewards in USDC. Docs: https://nadbounty.app`;
