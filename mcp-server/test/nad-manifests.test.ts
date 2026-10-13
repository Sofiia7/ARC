import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NadBountyAgent } from "arcbounty-agent-sdk";
import { createNadMcpServer } from "../src/nad-tools.js";

/**
 * The release metadata of nadbounty-mcp (package.json, server.json, the two .mcpb manifests) must describe the server
 * that is actually built here. These tests read those files and compare them with the live tool list, so a tool or a
 * description changed without `npm run sync:manifests` in ../nadbounty-mcp fails here instead of shipping stale.
 */

// Built from escapes so that this file itself holds neither character.
const DASHES = new RegExp("[\u2013\u2014]");
const dir = new URL("../../nadbounty-mcp/", import.meta.url);
const raw = (name: string) => readFileSync(new URL(name, dir), "utf8");
const json = (name: string) => JSON.parse(raw(name)) as Record<string, any>;
const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, any>;

async function liveTools() {
  const agent = { address: "0x1111111111111111111111111111111111111111", network: {} } as unknown as NadBountyAgent;
  const server = createNadMcpServer({ agent, hasSigner: true, version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(a);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("nadbounty-mcp release metadata", () => {
  const pkg = json("package.json");
  const registry = json("server.json");
  const manifest = json("manifest.json");
  const smithery = json("manifest.smithery.json");

  it("contains no en dash or em dash anywhere", () => {
    for (const name of [
      "package.json",
      "server.json",
      "manifest.json",
      "manifest.smithery.json",
      "README.md",
      "bin/nadbounty-mcp.mjs",
    ]) {
      expect(DASHES.test(raw(name)), name).toBe(false);
    }
  });

  it("names the package consistently for npm and the MCP registry", () => {
    expect(pkg).toMatchObject({
      name: "nadbounty-mcp",
      version: "0.2.0",
      mcpName: "io.github.Sofiia7/nadbounty-mcp",
      license: "MIT",
      homepage: "https://nadbounty.app",
      bugs: { url: "https://github.com/Sofiia7/ARC/issues" },
    });
    expect(registry.name).toBe(pkg.mcpName);
    expect(registry.version).toBe(pkg.version);
    expect(registry.packages).toHaveLength(1);
    expect(registry.packages[0]).toMatchObject({
      registryType: "npm",
      identifier: pkg.name,
      version: pkg.version,
      transport: { type: "stdio" },
    });
    expect(registry.description.length).toBeLessThanOrEqual(100);
    for (const keyword of [
      "mcp",
      "model-context-protocol",
      "monad",
      "nadbounty",
      "erc-8004",
      "erc-8183",
      "usdc",
      "x402",
      "ai-agent",
      "escrow",
      "autonomous-agents",
    ]) {
      expect(pkg.keywords).toContain(keyword);
    }
  });

  it("depends on the arcbounty-mcp release that carries this server, which needs the 0.11 SDK", () => {
    expect(own.version).toBe("0.8.0");
    expect(pkg.dependencies["arcbounty-mcp"]).toBe(`^${own.version}`);
    expect(own.dependencies["arcbounty-agent-sdk"]).toBe("^0.11.0");
    expect(json("../mcp-server/server.json")).toMatchObject({ version: own.version });
  });

  it("documents exactly the environment variables the server reads", () => {
    const registryVars = registry.packages[0].environmentVariables.map((v: { name: string }) => v.name).sort();
    expect(registryVars).toEqual([
      "NAD_BOUNTY_ADAPTER_ADDRESS",
      "NAD_MAX_REWARD_USDC",
      "NAD_MAX_SPEND_USDC",
      "NAD_NETWORK",
      "NAD_PRIVATE_KEY",
      "NAD_RPC_URL",
    ]);
    const secret = registry.packages[0].environmentVariables.find(
      (v: { name: string }) => v.name === "NAD_PRIVATE_KEY",
    );
    expect(secret.isSecret).toBe(true);
    const network = registry.packages[0].environmentVariables.find((v: { name: string }) => v.name === "NAD_NETWORK");
    expect(network).toMatchObject({ default: "monad-mainnet", choices: ["monad-mainnet", "monad-testnet"] });

    const env = manifest.server.mcp_config.env as Record<string, string>;
    expect(
      Object.keys(env)
        .filter((k) => k !== "NAD_MCP_VERSION")
        .sort(),
    ).toEqual(registryVars);
    expect(env["NAD_MCP_VERSION"]).toBe(pkg.version);
    for (const value of Object.values(env)) {
      const ref = /^\$\{user_config\.(\w+)\}$/.exec(value);
      if (ref) expect(manifest.user_config, value).toHaveProperty(ref[1]!);
    }
    expect(manifest.user_config.nad_private_key.sensitive).toBe(true);
    expect(manifest.user_config.nad_network.default).toBe("monad-mainnet");
    expect(manifest.server.entry_point).toBe("server/dist/nad-cli.js");
  });

  it("keeps both manifests at the package version with the same tools", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(smithery.version).toBe(pkg.version);
    expect({ ...smithery, tools: undefined }).toEqual({ ...manifest, tools: undefined });
    expect(smithery.tools.map((t: any) => [t.name, t.description])).toEqual(
      manifest.tools.map((t: any) => [t.name, t.description]),
    );
  });

  it("gives every Smithery tool a real inputSchema and the official manifest none", () => {
    for (const tool of smithery.tools) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: "object" });
      expect(typeof tool.inputSchema.properties, tool.name).toBe("object");
    }
    for (const tool of manifest.tools) expect(tool, tool.name).not.toHaveProperty("inputSchema");
  });

  it("matches the tools the built server advertises today", async () => {
    const live = await liveTools();
    const hint = "run `npm run sync:manifests` in nadbounty-mcp after building mcp-server";
    expect(
      smithery.tools.map((t: any) => t.name),
      hint,
    ).toEqual(live.map((t) => t.name));
    for (const tool of live) {
      const shipped = smithery.tools.find((t: any) => t.name === tool.name);
      expect(shipped.description, `${tool.name}: ${hint}`).toBe(tool.description);
      expect(shipped.inputSchema, `${tool.name}: ${hint}`).toEqual(JSON.parse(JSON.stringify(tool.inputSchema)));
    }
  });
});
