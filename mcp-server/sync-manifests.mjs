// Regenerate the `tools` array (and the version) of a .mcpb manifest pair from
// the tools/list a real server actually returns.
//
//   node sync-manifests.mjs [network] [manifest] [smithery-manifest]
//   node sync-manifests.mjs arc-testnet manifest.json manifest.smithery.json   (defaults)
//   node sync-manifests.mjs base-mainnet ../basebounty-mcp/manifest.json \
//                                        ../basebounty-mcp/manifest.smithery.json
//
// Two reasons this is a script and not a hand-maintained literal:
//
//  - Tool descriptions are now built from the resolved network (ArcBounty on
//    Arc where gas is USDC, BaseBounty on Base where it is ETH), so the same
//    build produces different text per network. Copying it by hand guarantees
//    a bundle that advertises the wrong chain.
//  - Smithery validates manifest tools as MCP `Tool[]`, where `inputSchema` is
//    a required object, while the official MCPB schema forbids the key. Hence
//    the pair: `manifest` stays spec-valid (name + description only) and
//    `smithery-manifest` carries the full schema. Both come from one dump, so
//    they cannot disagree about what the tools are.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const [, , network = "arc-testnet", manifestArg = "manifest.json", smitheryArg = "manifest.smithery.json"] = process.argv;
const manifestPath = resolve(here, manifestArg);
const smitheryPath = resolve(here, smitheryArg);

const tools = await dumpTools(network);
console.log(`[sync-manifests] ${network}: ${tools.length} tools`);

// `manifest` is the only file edited by hand. The Smithery variant is derived
// from it wholesale, so the two can differ in exactly one way - the tool
// schema - and never silently drift on description, user_config or version,
// which is what happened while they were maintained as two separate files.
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = pkg.version;
manifest.tools = tools.map(({ name, description }) => ({ name, description }));
write(manifestPath, manifest);

write(smitheryPath, {
  ...manifest,
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
});

function write(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  console.log(`[sync-manifests] wrote ${path} (version ${value.version})`);
}

function dumpTools(net) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: here,
      env: {
        ...process.env,
        ARC_NETWORK: net,
        // The burner from src/index.ts, purely so the write tools register and
        // tools/list is complete. It never signs anything: nothing is called.
        AGENT_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const send = msg => child.stdin.write(JSON.stringify(msg) + "\n");
    const fail = err => { child.kill(); reject(err); };
    const timer = setTimeout(() => fail(new Error(`timed out waiting for tools/list on ${net}`)), 60_000);

    let buf = "";
    child.stdout.on("data", d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(msg.result.tools);
        }
      }
    });
    child.stderr.on("data", d => process.stderr.write(d));
    child.on("error", fail);
    child.on("exit", code => { if (code) fail(new Error(`server exited ${code} on ${net}`)); });

    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sync-manifests", version: "0" } },
    });
  });
}
