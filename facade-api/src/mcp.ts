import { createRequire } from "node:module";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "arcbounty-mcp/server";
import { ArcBountyAgent } from "arcbounty-agent-sdk";
import type { Express, Request, Response } from "express";
import type { FacadeConfig } from "./config.js";

// Report the version of the package whose tools these actually are, so a
// client comparing a hosted server against a local install is comparing like
// with like. (package.json is exported by arcbounty-mcp for exactly this.)
const MCP_VERSION = (createRequire(import.meta.url)("arcbounty-mcp/package.json") as { version: string }).version;

/**
 * The same MCP server the npm package installs, served over HTTP so nobody has
 * to install it.
 *
 * Tools, wording and branding come from `arcbounty-mcp/server` rather than
 * being restated here: an agent that reaches this endpoint and one that ran
 * `npx arcbounty-mcp` must be looking at the same board described the same way.
 *
 * **Read-only, by construction.** `hasSigner: false` is not a configuration
 * choice that a future environment variable could flip. A signer here would be
 * *our* wallet signing for whoever called the endpoint - taking bounties in our
 * name, spending our gas, staking our worker bonds. Writing stays with the
 * local install, where the key belongs to the person running it.
 *
 * Free, unlike everything under /v1. x402 exists so agents pay for the
 * convenience of a hosted REST facade; charging for the protocol handshake
 * itself would just mean no agent ever completes one.
 */
export function mountMcp(app: Express, config: FacadeConfig): void {
  // Built once per function instance and shared: the underlying viem client
  // holds no per-request state, and Fluid Compute reuses instances, so this is
  // one RPC client rather than one per call.
  let agent: ArcBountyAgent | null = null;
  const getAgent = (): ArcBountyAgent => {
    if (!agent) {
      agent = new ArcBountyAgent({
        network: config.network,
        // The SDK constructor wants a signer even for view calls. This burner
        // is never used to sign: no write tool is registered above, so nothing
        // can reach it. Same constant, and same reasoning, as the read-only
        // mode of the stdio server.
        privateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
        bountyAdapterAddress: config.bountyAdapterAddress,
        rpcUrl: config.rpcUrl,
      });
    }
    return agent;
  };

  app.post("/mcp", async (req: Request, res: Response) => {
    // Stateless: a session would pin a client to one function instance, which
    // is not a promise this platform can keep. Every request carries its own
    // transport and its own short-lived server.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer({
      agent: getAgent(),
      hasSigner: false,
      version: MCP_VERSION,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[facade] mcp:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error" },
          id: null,
        });
      }
    }
  });

  // GET is where a stateful server would hand back an SSE stream. Saying so is
  // more useful than a bare 405, because "the endpoint is wrong" and "the
  // endpoint is stateless" look identical to a client otherwise.
  const notStreamable = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "This MCP endpoint is stateless: POST JSON-RPC to /mcp. No SSE stream, no session to delete.",
      },
      id: null,
    });
  };
  app.get("/mcp", notStreamable);
  app.delete("/mcp", notStreamable);
}
