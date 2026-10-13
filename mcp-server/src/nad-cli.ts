#!/usr/bin/env node
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNadMcpServer } from "./nad-tools.js";
import {
  NAD_USAGE,
  createNadAgent,
  resolveNadConfig,
  scrub,
  secretsOf,
  startupErrorMessage,
  startupLine,
  verifyRpc,
} from "./nad-config.js";

// The version a registry shows for this server comes from here. nadbounty-mcp is a shim over arcbounty-mcp, whose own
// version differs, so the shim (and the .mcpb manifest) pass theirs in NAD_MCP_VERSION.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const version = process.env["NAD_MCP_VERSION"]?.trim() || pkg.version;
const secrets = secretsOf(process.env);

/** Print to stderr, wait for it to flush and leave. A pending keep-alive socket must not delay the exit code. */
function fail(message: string): void {
  process.stderr.write(`[nadbounty] ${message}\n`, () => process.exit(1));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(NAD_USAGE);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(version);
    return;
  }

  const config = resolveNadConfig(process.env);
  await verifyRpc(config);
  const agent = createNadAgent(config);
  const server = createNadMcpServer({
    agent,
    hasSigner: config.privateKey !== undefined,
    version,
    limits: config.limits,
    secrets,
  });
  await server.connect(new StdioServerTransport());
  console.error(startupLine(config));
}

// A failure after startup must not print a raw stack: viem errors carry the RPC URL.
process.on("unhandledRejection", (error) => fail(`Unexpected error: ${scrub(String(error), secrets).slice(0, 300)}`));
process.on("uncaughtException", (error) => fail(`Unexpected error: ${scrub(String(error), secrets).slice(0, 300)}`));

main().catch((error) => fail(`Startup failed: ${startupErrorMessage(error, secrets)}`));
