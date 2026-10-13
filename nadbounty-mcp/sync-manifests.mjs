// Regenerate the `tools` array (and the version) of the .mcpb manifest pair from the tools/list the built server
// really returns. Run it after `npm --prefix ../mcp-server run build`; `npm run pack:mcpb` does both.
//
//   node sync-manifests.mjs [manifest] [smithery-manifest]
//   node sync-manifests.mjs manifest.json manifest.smithery.json   (defaults)
//
// Same idea as ../mcp-server/sync-manifests.mjs, for the Monad server:
//
//  - `manifest.json` is the only file edited by hand. This script rewrites its version, the NAD_MCP_VERSION it hands
//    to the server, and its `tools`. The official MCPB schema forbids `inputSchema` in a manifest tool, so that file
//    carries name and description only.
//  - Smithery validates manifest tools as MCP `Tool[]`, where `inputSchema` is a required object: a tool without one
//    is rejected with a 400 "expected object", one error per tool. `manifest.smithery.json` is therefore derived from
//    `manifest.json` wholesale and differs in exactly one way, the schema each tool carries. Both come from one dump,
//    so they cannot disagree about what the tools are.
//
// The dump needs no network: the server's startup check (chain id, code at the adapter) is answered by a throwaway
// local JSON-RPC stub, and tools/list calls no chain method at all.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Neither an en dash nor an em dash may reach a published manifest (one rendered as mojibake in a live registry once).
const DASHES = new RegExp("[\u2013\u2014]");

const here = dirname(fileURLToPath(import.meta.url));
const pkg = createRequire(import.meta.url)("./package.json");
const serverEntry = resolve(here, "../mcp-server/dist/nad-cli.js");

const [, , manifestArg = "manifest.json", smitheryArg = "manifest.smithery.json"] = process.argv;
const manifestPath = resolve(here, manifestArg);
const smitheryPath = resolve(here, smitheryArg);

const tools = await dumpTools();
console.log(`[sync-manifests] ${tools.length} tools`);
const missingSchema = tools.filter((tool) => !tool.inputSchema || typeof tool.inputSchema !== "object");
if (missingSchema.length)
  throw new Error(`tools without an inputSchema: ${missingSchema.map((t) => t.name).join(", ")}`);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = pkg.version;
manifest.server.mcp_config.env.NAD_MCP_VERSION = pkg.version;
manifest.tools = tools.map(({ name, description }) => ({ name, description }));
write(manifestPath, manifest);

write(smitheryPath, {
  ...manifest,
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
});

function write(path, value) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (DASHES.test(text)) throw new Error(`${path}: contains an en or em dash`);
  writeFileSync(path, text);
  console.log(`[sync-manifests] wrote ${path} (version ${value.version})`);
}

/** A node that answers just the two calls the server makes at startup. */
function startStubRpc() {
  const node = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const answer = (call) =>
        call.method === "eth_chainId"
          ? { jsonrpc: "2.0", id: call.id, result: "0x8f" } // 143, Monad mainnet
          : call.method === "eth_getCode"
            ? { jsonrpc: "2.0", id: call.id, result: "0x6080" }
            : { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "stub" } };
      const parsed = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  return new Promise((resolvePromise) =>
    node.listen(0, "127.0.0.1", () => resolvePromise({ node, url: `http://127.0.0.1:${node.address().port}` })),
  );
}

async function dumpTools() {
  const stub = await startStubRpc();
  try {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [serverEntry], {
        env: {
          ...process.env,
          NAD_NETWORK: "monad-mainnet",
          NAD_RPC_URL: stub.url,
          NAD_MCP_VERSION: pkg.version,
          // The burner from ../mcp-server/sync-manifests.mjs, only so the write tools register and tools/list is
          // complete. It never signs anything: no tool is called.
          NAD_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
          // Defaults, so the caps quoted in tool descriptions are the documented ones whatever the shell exports.
          NAD_MAX_REWARD_USDC: "",
          NAD_MAX_SPEND_USDC: "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
      const fail = (error) => {
        child.kill();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("timed out waiting for tools/list")), 90_000);
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let i;
        while ((i = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          }
          if (message.id === 2) {
            clearTimeout(timer);
            child.kill();
            resolvePromise(message.result.tools);
          }
        }
      });
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      child.on("error", fail);
      child.on("exit", (code) => {
        if (code) fail(new Error(`server exited ${code}`));
      });
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "sync-manifests", version: "0" },
        },
      });
    });
  } finally {
    stub.node.close();
  }
}
