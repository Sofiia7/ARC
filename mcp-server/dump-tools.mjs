// Enumerate the real tools/list output of the built ArcBounty MCP server so the
// .mcpb manifest carries the exact inputSchema each tool actually advertises.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: "C:/Server/ARC/mcp-server",
  env: {
    ...process.env,
    BOUNTY_ADAPTER_ADDRESS: "0x538CD48789667168bfb36f838Af8476237F9409F",
    // burner key straight out of src/index.ts — only forces the write tools to
    // register so tools/list is complete; never used to sign anything
    AGENT_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

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
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    }
    if (msg.id === 2) {
      console.log(JSON.stringify(msg.result.tools, null, 2));
      child.kill();
      process.exit(0);
    }
  }
});
child.stderr.on("data", d => process.stderr.write(d));

child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dump", version: "1" } },
}) + "\n");

setTimeout(() => { console.error("timeout"); process.exit(1); }, 20000);
