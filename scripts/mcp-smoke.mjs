#!/usr/bin/env node
// Smoke test for an MCP server package before it is published to npm.
//
//   node scripts/mcp-smoke.mjs <entry.mjs|js> [--expect-version X.Y.Z]
//
// Starts the server over stdio with no credentials (browse-only mode), sends
// `initialize` and `tools/list`, and fails unless the server answers with at
// least one tool. With --expect-version it also checks the version the server
// reports at `initialize`, which is what the MCP registries display.
//
// Used by .github/workflows/npm-publish.yml for arcbounty-mcp, basebounty-mcp
// and nadbounty-mcp. The two shims import `arcbounty-mcp` from node_modules, so
// for them this checks what an `npx basebounty-mcp` user actually gets.
import { spawn } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const entry = args[0];
const vi = args.indexOf("--expect-version");
const expectVersion = vi >= 0 ? args[vi + 1] : undefined;
if (!entry || (vi >= 0 && !expectVersion)) {
  console.error("usage: node scripts/mcp-smoke.mjs <entry> [--expect-version X.Y.Z]");
  process.exit(2);
}

const TIMEOUT_MS = 60_000;
const env = { ...process.env };
// Browse-only: never hand a signing key to a smoke test, even if the runner has one.
for (const k of ["AGENT_PRIVATE_KEY", "NAD_PRIVATE_KEY", "CIRCLE_API_KEY", "ENTITY_SECRET", "CIRCLE_WALLET_ID"]) delete env[k];

const child = spawn(process.execPath, [path.resolve(entry)], { env, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });

function fail(msg) {
  console.error(`mcp-smoke: FAIL - ${msg}`);
  if (stderr.trim()) console.error(`--- server stderr ---\n${stderr.trim().slice(-4000)}`);
  child.kill();
  process.exit(1);
}

const timer = setTimeout(() => fail(`no tools/list answer within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);
child.on("exit", (code, signal) => fail(`server exited early (code ${code}, signal ${signal})`));

const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
let serverInfo;
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { fail(`stdout is not JSON-RPC: ${line.slice(0, 200)}`); }
    if (msg.error) fail(`request ${msg.id} returned error: ${JSON.stringify(msg.error)}`);
    if (msg.id === 1) {
      serverInfo = msg.result?.serverInfo;
      if (!serverInfo?.name) fail(`initialize returned no serverInfo: ${line.slice(0, 300)}`);
      if (expectVersion && serverInfo.version !== expectVersion) {
        fail(`server reports version ${serverInfo.version}, package.json says ${expectVersion}`);
      }
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/list", params: {} });
    } else if (msg.id === 2) {
      const tools = msg.result?.tools ?? [];
      if (tools.length === 0) fail("tools/list returned no tools");
      clearTimeout(timer);
      child.removeAllListeners("exit");
      child.kill();
      console.log(`mcp-smoke: OK - ${serverInfo.name}@${serverInfo.version}, ${tools.length} tools`);
      process.exit(0);
    }
  }
});

send({
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "npm-publish-smoke", version: "1" } },
});
