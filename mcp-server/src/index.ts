#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ArcBountyAgent,
  pinAgentMetadata,
  workerBondFor,
  type AgentMetadata,
  type BountyMeta,
  type PendingAction,
  type NetworkName,
} from "arcbounty-agent-sdk";

// Read name and version off package.json instead of repeating them here:
// registries label their listings with whatever the server reports at
// `initialize`, so a stale literal shows up publicly as a version that doesn't
// exist on npm - Glama's first release went out as 0.1.0 while npm was already
// on 0.1.1. The name doubles as the stderr tag, so a differently-named
// distribution of this same server labels its own logs correctly.
const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string };
const TAG = `[${pkg.name}]`;

// ─── Agent instance ────────────────────────────────────────────────────────
//
// Read-only tools always work (no signer needed - listOpenBounties/getBounty
// are public view calls). Write tools (take/submit/register/...) only
// register if a signer is configured, via the same env-var conventions the
// SDK itself and its examples already use:
//
//   ARC_NETWORK               - which chain this instance serves: "arc-testnet"
//                               (default), "arc-mainnet", "base-sepolia" or
//                               "base-mainnet". The Base entries are the same
//                               product under its own name, BaseBounty
//                               (basebounty.app) - one package, one instance
//                               per chain, brand read from the network.
//                               arc-mainnet additionally requires the SDK's
//                               ARC_MAINNET_* variables (see .env.example) -
//                               resolveNetwork() throws a descriptive error
//                               listing anything missing.
//   AGENT_PRIVATE_KEY        - raw EOA private key, OR:
//   CIRCLE_API_KEY / ENTITY_SECRET / CIRCLE_WALLET_ID / CIRCLE_WALLET_ADDRESS
//                             - Circle developer-controlled wallet (no key
//                               in this process at all - see
//                               agent-sdk/docs/circle-wallet.md)
//   BOUNTY_ADAPTER_ADDRESS    - optional override, testnets only. Every network
//                               ships its canonical adapter inside the SDK, so
//                               an unconfigured server is a working read-only
//                               one. The SDK ignores this variable on mainnet
//                               chains on purpose, so that a stale testnet
//                               address can never leak onto mainnet - which is
//                               why this file hands the decision to the SDK
//                               rather than reading the variable itself.
//                               Source of truth: contracts/DEPLOYMENTS.md.
//   ARC_RPC_URL (optional)    - overrides the RPC endpoint for whichever
//                               network ARC_NETWORK resolves to (unchanged
//                               from pre-network-selection behavior - this is
//                               a transport-only override, so on arc-mainnet
//                               it still talks to the mainnet chain id, just
//                               through this URL instead of ARC_MAINNET_RPC_URL).
//                               The SDK's own BASE_MAINNET_RPC_URL /
//                               BASE_SEPOLIA_RPC_URL do the same for the Base
//                               entries; ARC_RPC_URL wins over both.

const KNOWN_NETWORKS = [
  "arc-testnet",
  "arc-mainnet",
  "base-sepolia",
  "base-mainnet",
] as const satisfies readonly NetworkName[];

// Compile-time drift guard. This list said "arc-testnet, arc-mainnet" for the
// two weeks BaseBounty was live on Base mainnet: ARC_NETWORK=base-mainnet was
// refused at startup by a server whose SDK supported it perfectly well, and
// nothing failed loudly enough to notice. A NetworkName the list doesn't cover
// now breaks the build here - the error names the missing network - instead of
// breaking at someone else's runtime.
type UnlistedNetwork = Exclude<NetworkName, (typeof KNOWN_NETWORKS)[number]>;
const _networksExhaustive: [UnlistedNetwork] extends [never] ? true : UnlistedNetwork = true;
void _networksExhaustive;

/** Returns `null` (after logging) on an unrecognized ARC_NETWORK value, mirroring
 * the other startup-validation failures in this function. */
function readNetwork(): NetworkName | null {
  const raw = process.env["ARC_NETWORK"];
  if (!raw) return "arc-testnet";
  if ((KNOWN_NETWORKS as readonly string[]).includes(raw)) return raw as NetworkName;
  console.error(
    `${TAG} Invalid ARC_NETWORK="${raw}" - expected one of: ${KNOWN_NETWORKS.join(", ")}. ` +
    "Server will not start.",
  );
  return null;
}

function buildAgent(): ArcBountyAgent | null {
  const network = readNetwork();
  if (!network) return null;

  // Deliberately not read here: BOUNTY_ADAPTER_ADDRESS. Passing it as an
  // explicit constructor argument would override the SDK's own precedence
  // (explicit > env-on-testnet > the network's canonical adapter) and defeat
  // its guard against a testnet address leaking onto a mainnet chain. Leaving
  // it to the SDK also means every network now has a default, so the server
  // starts read-only with no configuration at all.
  const rpcUrl = process.env["ARC_RPC_URL"];

  const circleApiKey = process.env["CIRCLE_API_KEY"];
  const entitySecret = process.env["ENTITY_SECRET"];
  const circleWalletId = process.env["CIRCLE_WALLET_ID"];
  const circleWalletAddress = process.env["CIRCLE_WALLET_ADDRESS"] as `0x${string}` | undefined;
  const privateKey = process.env["AGENT_PRIVATE_KEY"] as `0x${string}` | undefined;

  if (circleApiKey && entitySecret && circleWalletId && circleWalletAddress) {
    return new ArcBountyAgent({
      network,
      circleWallet: { apiKey: circleApiKey, entitySecret, walletId: circleWalletId, address: circleWalletAddress },
      rpcUrl,
    });
  }
  if (privateKey) {
    return new ArcBountyAgent({ network, privateKey, rpcUrl });
  }

  // No signer configured - read-only mode. Still useful: browsing bounties
  // needs no credentials at all.
  console.error(
    `${TAG} No signer configured (AGENT_PRIVATE_KEY or CIRCLE_API_KEY+ENTITY_SECRET+` +
    "CIRCLE_WALLET_ID+CIRCLE_WALLET_ADDRESS) - starting in READ-ONLY mode. " +
    "take_bounty/submit_work/register_agent/etc. will not be registered.",
  );
  // ArcBountyAgent's constructor requires a signer; view-only calls (listOpenBounties,
  // getBounty, getReputation) don't actually need one, so we use a throwaway
  // burner key purely to satisfy the constructor - it is never used to sign
  // anything because no write tools are registered in this mode.
  const burner = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
  return new ArcBountyAgent({ network, privateKey: burner, rpcUrl });
}

let agent: ArcBountyAgent | null;
try {
  agent = buildAgent();
} catch (err) {
  // Thrown by the SDK constructor itself - most commonly resolveNetwork()
  // rejecting ARC_NETWORK=arc-mainnet because the ARC_MAINNET_* variables
  // aren't set yet (Circle hasn't published mainnet parameters). The SDK's
  // error message already lists exactly what's missing.
  console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
  agent = null;
}
if (!agent) process.exit(1);

const hasSigner = Boolean(
  process.env["AGENT_PRIVATE_KEY"] ||
  (process.env["CIRCLE_API_KEY"] && process.env["ENTITY_SECRET"] && process.env["CIRCLE_WALLET_ID"] && process.env["CIRCLE_WALLET_ADDRESS"]),
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function summarize(m: BountyMeta) {
  return {
    jobId: m.jobId.toString(),
    reward: agent!.formatUsdc(m.reward),
    category: m.category,
    tags: m.tags,
    deadline: new Date(Number(m.deadline) * 1000).toISOString(),
    agentOnly: m.agentOnly,
    humanOnly: m.humanOnly,
    isTaken: m.isTaken,
    resolved: m.resolved,
    hasSubmission: m.submittedResultHash.length > 0,
    descriptionCid: m.ipfsDescHash,
    assignedProvider: m.assignedProvider,
    poster: m.poster,
    // V4 worker bond: taking this bounty requires posting a refundable USDC
    // bond (refunded at submit_work; forfeited only on take-and-vanish).
    requireWorkerBond: m.requireWorkerBond,
    ...(m.requireWorkerBond
      ? { workerBondUsdc: agent!.formatUsdc(m.workerBond > 0n ? m.workerBond : workerBondFor(m.reward)) }
      : {}),
  };
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

// ─── Server ─────────────────────────────────────────────────────────────────

// The resolved network decides what this instance is called and what it says.
// On Arc it is ArcBounty and gas is USDC; on Base it is BaseBounty and gas is
// ETH, which an agent has to know before it funds a wallet and discovers it
// cannot broadcast. Both come from the SDK's network entry, so nothing here
// hardcodes one chain's answer.
const net = agent!.network;
const BRAND = net.brand.name;
/** Non-empty only where the gas token is not the reward token, i.e. on Base. */
const GAS_NOTE = net.nativeCurrency.isUsdc
  ? ""
  : ` Gas on ${net.name} is paid in ${net.nativeCurrency.symbol}, not USDC: this wallet needs a little ` +
    `${net.nativeCurrency.symbol} on top of any USDC, or the transaction cannot be broadcast at all.`;

const server = new McpServer({ name: BRAND.toLowerCase(), version: pkg.version });

// -- Read-only tools (always registered) -------------------------------------

server.registerTool(
  "list_open_bounties",
  {
    description:
      `List open (unassigned, unresolved, not-yet-expired) bounties on ${BRAND}, the on-chain bounty board ` +
      `running on ${net.name}. Rewards are in USDC. Use this to find work to take on, or to survey the ` +
      "current market.",
    inputSchema: z.object({
      category: z.enum(["dev", "design", "content", "data", "other"]).optional()
        .describe("Filter by category. Omit for all categories."),
      agentOnly: z.boolean().optional().describe("If true, only bounties restricted to ERC-8004 agents."),
      humanOnly: z.boolean().optional().describe("If true, only bounties restricted to humans."),
      minReward: z.number().optional().describe("Minimum reward in USDC dollars."),
      maxReward: z.number().optional().describe("Maximum reward in USDC dollars."),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
    }),
  },
  async ({ category, agentOnly, humanOnly, minReward, maxReward, limit }) => {
    try {
      const bounties = await agent!.listOpenBounties({
        category, agentOnly, humanOnly, minReward, maxReward, limit: limit ?? 20,
      });
      return json(bounties.map(summarize));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_bounty",
  {
    description: "Get full details for one bounty by jobId, including its description fetched from IPFS.",
    inputSchema: z.object({ jobId: z.string().describe("The bounty's jobId, as a string (it's a uint256 on-chain).") }),
  },
  async ({ jobId }) => {
    try {
      const meta = await agent!.getBounty(BigInt(jobId));
      let description = "";
      try {
        description = await agent!.getBountyDescription(BigInt(jobId));
      } catch {
        description = "(failed to fetch description from IPFS gateways)";
      }
      return json({ ...summarize(meta), description });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_reputation",
  {
    description: "Get an ERC-8004 agent's on-chain reputation score (average score, total feedbacks, total jobs).",
    inputSchema: z.object({
      agentId: z.string().optional().describe("Agent's ERC-8004 id. Omit to use this server's own configured agent."),
    }),
  },
  async ({ agentId }) => {
    try {
      const rep = await agent!.getReputation(agentId !== undefined ? BigInt(agentId) : undefined);
      return json({
        averageScore: rep.averageScore.toString(),
        totalFeedbacks: rep.totalFeedbacks.toString(),
        totalJobs: rep.totalJobs.toString(),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

if (hasSigner) {
  // -- Identity ---------------------------------------------------------------

  server.registerTool(
    "register_agent",
    {
      description:
        `Register this server's configured wallet as an ERC-8004 agent on ${net.name}, pinning the given ` +
        "metadata to IPFS first. Idempotent - if this wallet already has an agentId, returns the existing one " +
        "without a new on-chain transaction." + GAS_NOTE,
      inputSchema: z.object({
        name: z.string(),
        description: z.string(),
        agent_type: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        preferred_categories: z.array(z.enum(["dev", "design", "content", "data", "other"])).optional(),
        min_reward_usdc: z.number().optional(),
        max_reward_usdc: z.number().optional(),
      }),
    },
    async (args) => {
      try {
        const metadata: AgentMetadata = {
          name: args.name,
          description: args.description,
          agent_type: args.agent_type,
          capabilities: args.capabilities,
          arcbounty: {
            preferred_categories: args.preferred_categories,
            min_reward_usdc: args.min_reward_usdc,
            max_reward_usdc: args.max_reward_usdc,
          },
        };
        const metadataURI = await pinAgentMetadata(metadata);
        const agentId = await agent!.register(metadataURI);
        return json({ agentId: agentId.toString(), metadataURI, address: agent!.address });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_agent_info",
    { description: "Get this server's own configured agent identity, address, and reputation." },
    async () => {
      try {
        const info = await agent!.getAgentInfo();
        return json({
          agentId: info.agentId.toString(),
          address: info.address,
          metadataURI: info.metadataURI,
          reputation: {
            averageScore: info.reputation.averageScore.toString(),
            totalFeedbacks: info.reputation.totalFeedbacks.toString(),
            totalJobs: info.reputation.totalJobs.toString(),
          },
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_my_bounties",
    { description: "List bounties currently assigned to this server's configured wallet as worker." },
    async () => {
      try {
        const mine = await agent!.getMyBounties();
        return json(mine.map(summarize));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_pending_actions",
    {
      description:
        "Check this wallet's own bounties for anything needing attention RIGHT NOW: a dispute opened against " +
        "it with no response yet, a rejection not yet challenged, or funds it can claim permissionlessly " +
        "(auto-approve after the poster went silent, or a default arbitrator ruling after a timeout). Read-only " +
        "- reports, never acts. This server has no background watchdog: if this bounty board matters to you, " +
        "call this at the start of every session (or on a timer) so a dispute doesn't quietly expire while " +
        "you weren't looking. An empty list means nothing needs you right now.",
    },
    async () => {
      try {
        const actions = await agent!.getPendingActions();
        return json(actions.map((a: PendingAction) => ({
          kind: a.kind,
          jobId: a.jobId.toString(),
          message: a.message,
          bounty: summarize(a.meta),
        })));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -- Worker lifecycle ---------------------------------------------------------

  server.registerTool(
    "take_bounty",
    {
      description:
        "Claim an open bounty as this server's configured wallet. On-chain and atomic - fails if someone else " +
        "already took it. Do this only after reviewing the bounty with get_bounty. If the bounty has " +
        "requireWorkerBond, a refundable USDC bond (workerBondUsdc) is approved and pulled automatically - " +
        "it is returned in full at submit_work, so only take bonded bounties you intend to finish." + GAS_NOTE,
      inputSchema: z.object({ jobId: z.string() }),
    },
    async ({ jobId }) => {
      try {
        const result = await agent!.takeBounty(BigInt(jobId));
        return json({ txHash: result.hash });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "submit_work",
    {
      description:
        "Submit completed work for a bounty this wallet has taken. The text is pinned to IPFS automatically. " +
        "This starts the poster's review window - the poster can approve, reject (with a 48h challenge window), " +
        "or the payout becomes claimable permissionlessly after 14 days if the poster never responds.",
      inputSchema: z.object({
        jobId: z.string(),
        text: z.string().describe("The deliverable, as markdown/plain text."),
      }),
    },
    async ({ jobId, text }) => {
      try {
        const result = await agent!.submitWork(BigInt(jobId), { text });
        return json({ txHash: result.hash });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -- Permissionless liveness helpers (safe to expose broadly) ----------------

  server.registerTool(
    "auto_approve",
    {
      description:
        "Permissionlessly claim payout for a bounty this wallet submitted work for, once the poster has gone " +
        "silent for 14 days past submission (APPROVAL_TIMEOUT). Fails harmlessly if the window hasn't elapsed.",
      inputSchema: z.object({ jobId: z.string() }),
    },
    async ({ jobId }) => {
      try {
        const result = await agent!.autoApprove(BigInt(jobId));
        return json({ txHash: result.hash });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

// Intentionally NOT exposed in v0: approveBounty/rejectBounty/disputeBounty/
// respondToDispute/resolveDispute/claimDefaultRuling/claimArbitratorTimeout/
// cancelBounty. Those are poster- or arbitrator-side judgment calls (rejecting
// real work, ruling on evidence) that shouldn't be one blind tool call away
// from an arbitrary MCP client - they belong in the full SDK or the dashboard
// until there's a concrete case for exposing them here too.

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // console.error, never console.log - stdout is the JSON-RPC transport
  // itself, and anything printed there corrupts the stream from the host's
  // perspective.
  // Name the chain and the adapter, not just "running": an instance pointed at
  // the wrong network is otherwise indistinguishable from a working one until
  // its first empty board.
  console.error(
    `${TAG} ${BRAND} running on stdio - ${net.name} (chain ${net.chainId})` +
    `${hasSigner ? "" : " - read-only mode, no signer configured"}`,
  );
}

main().catch(err => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
