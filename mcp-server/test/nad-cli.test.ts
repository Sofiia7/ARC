import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * Runs the real entry point (src/nad-cli.ts through tsx) as a child process, against a local fake JSON-RPC node, so the
 * exit code, the stderr text and the stdio protocol are the ones a user sees. Nothing here touches the network.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const KEY = `0x${"22".repeat(32)}`;
const SIGNER_ADDRESS = "0x1563915e194D8CfBA1943570603F7606A3115508";
const CANONICAL = "0x5C38F98Fb3F3BA3eB8206Cb653eeDC8C159E1bE4";

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

/** A node that knows eth_chainId and eth_getCode and refuses everything else. */
async function fakeRpc(opts: { chainId?: number; code?: string } = {}): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const answer = (call: { id: number; method: string }) =>
        call.method === "eth_chainId"
          ? { jsonrpc: "2.0", id: call.id, result: `0x${(opts.chainId ?? 143).toString(16)}` }
          : call.method === "eth_getCode"
            ? { jsonrpc: "2.0", id: call.id, result: opts.code ?? "0x6080" }
            : { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "not supported by the fake node" } };
      const parsed = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function cliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(NAD_|ARCBOUNTY_|PINATA_|ARC_|AGENT_)/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

function spawnCli(env: Record<string, string>, args: string[] = []) {
  return spawn(process.execPath, ["--import", "tsx", "src/nad-cli.ts", ...args], {
    cwd: root,
    env: cliEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Run to completion (startup failure, --help). */
function run(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnCli(env, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Start the server, speak MCP over stdio, then stop it. */
async function session(env: Record<string, string>, calls: { name: string; arguments: object }[] = []) {
  const child = spawnCli(env);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const waiting = new Map<number, (message: any) => void>();
  let buffer = "";
  child.stdout.on("data", (d) => {
    buffer += d;
    let i: number;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) {
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
      }
    }
  });
  let id = 0;
  const rpc = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const mine = ++id;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}; stderr: ${stderr}`)), 60_000);
      waiting.set(mine, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n");
    });
  try {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await rpc("tools/list", {});
    const results = [];
    for (const call of calls) results.push(await rpc("tools/call", call));
    return {
      init: init.result,
      tools: list.result.tools.map((t: { name: string }) => t.name) as string[],
      results,
      stderr,
    };
  } finally {
    child.kill();
  }
}

describe.concurrent("startup failures exit 1 with a precise, sanitized cause on stderr", () => {
  it("unsupported NAD_NETWORK", async () => {
    const r = await run({ NAD_NETWORK: "bogus" });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      '[nadbounty] Startup failed: NAD_NETWORK="bogus" is not supported. Use monad-mainnet (the default) or monad-testnet.\n',
    );
    expect(r.stdout).toBe("");
  }, 90_000);

  it("testnet without an adapter", async () => {
    const r = await run({ NAD_NETWORK: "monad-testnet" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /Startup failed: monad-testnet has no built-in NadBounty deployment: set NAD_BOUNTY_ADAPTER_ADDRESS/,
    );
  }, 90_000);

  it("a malformed key is rejected without being printed", async () => {
    const r = await run({ NAD_PRIVATE_KEY: "super-secret-but-malformed-value-1234567890" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/NAD_PRIVATE_KEY is set but is not a 32-byte hex private key/);
    expect(r.stderr).not.toContain("super-secret");
  }, 90_000);

  it("an unreachable RPC, without its address", async () => {
    const r = await run({ NAD_RPC_URL: "http://127.0.0.1:1/private-path" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Startup failed: Could not reach the RPC from NAD_RPC_URL/);
    expect(r.stderr).not.toMatch(/127\.0\.0\.1|private-path|http/);
  }, 90_000);

  it("a node on another chain", async () => {
    const url = await fakeRpc({ chainId: 1 });
    const r = await run({ NAD_RPC_URL: url });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/reports chain id 1, but monad-mainnet is chain id 143/);
    expect(r.stderr).not.toContain("127.0.0.1");
  }, 90_000);

  it("an adapter address with no contract behind it", async () => {
    const url = await fakeRpc({ code: "0x" });
    const r = await run({ NAD_RPC_URL: url });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`No contract is deployed at the adapter address ${CANONICAL} on monad-mainnet.`);
  }, 90_000);
});

describe.concurrent("normal runs", () => {
  it("--help and --version answer without any network", async () => {
    const help = await run({}, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("NAD_PRIVATE_KEY");
    expect(help.stdout).toContain("monad-mainnet (default)");
    const version = await run({ NAD_MCP_VERSION: "9.8.7" }, ["--version"]);
    expect(version.stdout.trim()).toBe("9.8.7");
  }, 90_000);

  it("defaults to mainnet and the canonical adapter, read-only, with zero configuration", async () => {
    const url = await fakeRpc();
    const s = await session({ NAD_RPC_URL: url, NAD_MCP_VERSION: "1.2.3" }, [{ name: "network", arguments: {} }]);
    expect(s.init.serverInfo).toEqual({ name: "nadbounty", version: "1.2.3" });
    expect(s.tools).toHaveLength(13);
    expect(s.tools).not.toContain("post_bounty");
    expect(s.stderr).toBe(
      `[nadbounty] monad-mainnet (chain 143), adapter ${CANONICAL} (built-in canonical), read-only (no NAD_PRIVATE_KEY, so write tools are not registered). Gas: MON.\n`,
    );
    const network = JSON.parse(s.results[0].result.content[0].text);
    expect(network).toMatchObject({ network: "monad-mainnet", chainId: 143, adapter: CANONICAL, mode: "read-only" });
    expect(network.board.paused).toBe("unavailable");
  }, 90_000);

  it("registers the write tools with a key, logs the signer and never the key", async () => {
    const url = await fakeRpc();
    const s = await session({ NAD_RPC_URL: url, NAD_PRIVATE_KEY: KEY, NAD_MAX_REWARD_USDC: "7" });
    expect(s.tools).toHaveLength(48);
    expect(s.tools).toContain("post_bounty");
    expect(s.stderr).toContain(`signing as ${SIGNER_ADDRESS}`);
    expect(s.stderr).toContain("7 USDC per bounty and 50 USDC per run");
    expect(s.stderr).not.toContain(KEY.slice(2));
    expect(s.stderr).not.toContain("127.0.0.1");
  }, 90_000);
});
