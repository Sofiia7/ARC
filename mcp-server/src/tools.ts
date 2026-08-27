import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  pinAgentMetadata,
  workerBondFor,
  type AgentMetadata,
  type ArcBountyAgent,
  type BountyMeta,
  type PendingAction,
} from "arcbounty-agent-sdk";

/**
 * Build the MCP server for one already-configured agent.
 *
 * Split out of the stdio entry point so the same tools, the same wording and
 * the same network-derived branding can be served over other transports - the
 * hosted HTTP endpoint in particular, where nobody installs anything and so
 * nobody can be asked to set environment variables.
 *
 * `hasSigner` is the only thing that changes the surface: without one, only
 * the three read-only tools are registered. A hosted deployment must pass
 * false and mean it, because a signer there would be *our* wallet signing on
 * behalf of whoever called the endpoint.
 */
export function createMcpServer({
  agent,
  hasSigner,
  version,
}: {
  agent: ArcBountyAgent;
  hasSigner: boolean;
  version: string;
}): McpServer {
  // ─── Helpers ────────────────────────────────────────────────────────────────

  function summarize(m: BountyMeta) {
    return {
      jobId: m.jobId.toString(),
      reward: agent.formatUsdc(m.reward),
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
        ? { workerBondUsdc: agent.formatUsdc(m.workerBond > 0n ? m.workerBond : workerBondFor(m.reward)) }
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
  const net = agent.network;
  const BRAND = net.brand.name;
  /** Non-empty only where the gas token is not the reward token, i.e. on Base. */
  const GAS_NOTE = net.nativeCurrency.isUsdc
    ? ""
    : ` Gas on ${net.name} is paid in ${net.nativeCurrency.symbol}, not USDC: this wallet needs a little ` +
      `${net.nativeCurrency.symbol} on top of any USDC, or the transaction cannot be broadcast at all.`;

  const server = new McpServer({ name: BRAND.toLowerCase(), version });

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
        const bounties = await agent.listOpenBounties({
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
        const meta = await agent.getBounty(BigInt(jobId));
        let description = "";
        try {
          description = await agent.getBountyDescription(BigInt(jobId));
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
        const rep = await agent.getReputation(agentId !== undefined ? BigInt(agentId) : undefined);
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
          const agentId = await agent.register(metadataURI);
          return json({ agentId: agentId.toString(), metadataURI, address: agent.address });
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
          const info = await agent.getAgentInfo();
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
          const mine = await agent.getMyBounties();
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
          const actions = await agent.getPendingActions();
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
          const result = await agent.takeBounty(BigInt(jobId));
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
          const result = await agent.submitWork(BigInt(jobId), { text });
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
          const result = await agent.autoApprove(BigInt(jobId));
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


  return server;
}
