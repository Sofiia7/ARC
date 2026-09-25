import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fetchIpfsText,
  pinAgentMetadata,
  workerBondFor,
  type AgentMetadata,
  type ArcBountyAgent,
  type BountyMeta,
  type PendingAction,
} from "arcbounty-agent-sdk";
import { DEFAULT_SPEND_LIMITS, spendLimitError, type SpendLimits } from "./limits.js";

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
 *
 * `limits` caps what post_bounty may spend - see limits.ts.
 */
export function createMcpServer({
  agent,
  hasSigner,
  version,
  limits = DEFAULT_SPEND_LIMITS,
}: {
  agent: ArcBountyAgent;
  hasSigner: boolean;
  version: string;
  limits?: SpendLimits;
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
        // A poster reviews the delivery from here before approve_bounty. Workers
        // submit either an ipfs:// document or a link (a gist, a PR, a post).
        const submittedResult = meta.submittedResultHash || null;
        let submission: string | undefined;
        if (submittedResult?.startsWith("ipfs://")) {
          try {
            submission = await fetchIpfsText(submittedResult);
          } catch {
            submission = "(failed to fetch the submission from IPFS gateways)";
          }
        }
        return json({ ...summarize(meta), description, submittedResult, ...(submission ? { submission } : {}) });
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

    // -- Time-boxed worker defenses (V4.7, M-03) ---------------------------------
    //
    // get_pending_actions can report "rejection_pending" or
    // "dispute_needs_response" - both mean this wallet loses by default if it
    // does nothing before a 48h window closes. Before this fix, an MCP client
    // could detect either but had no tool to act on it: challengeRejection and
    // respondToDispute existed on the SDK but were never registered here. This
    // was an oversight, not the deliberate exclusion the comment below still
    // describes for the other, genuinely judgment-call methods - these two are
    // narrow, worker-side, time-boxed self-defense, not a poster/arbitrator
    // ruling on someone else's work.

    server.registerTool(
      "challenge_rejection",
      {
        description:
          "Challenge a poster's rejection of this wallet's submitted work, within the 48h challenge window " +
          "(REJECTION_CHALLENGE_WINDOW). This turns the rejection into a dispute for the arbitrator to rule on. " +
          "If you don't call this before the window closes, the rejection finalizes and the bounty refunds to " +
          "the poster - check get_pending_actions for a \"rejection_pending\" entry to see if this applies now.",
        inputSchema: z.object({
          jobId: z.string(),
          text: z.string().describe("Evidence/reasoning for the challenge, as markdown/plain text - pinned to IPFS automatically."),
        }),
      },
      async ({ jobId, text }) => {
        try {
          const result = await agent.challengeRejection(BigInt(jobId), { text });
          return json({ txHash: result.hash });
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "respond_to_dispute",
      {
        description:
          "Respond to a dispute the other party opened against this wallet, within the 48h response window " +
          "(DISPUTE_RESPONSE_WINDOW). If you don't respond before the window closes, the other party can claim " +
          "a default ruling in their favor (claimDefaultRuling) - check get_pending_actions for a " +
          "\"dispute_needs_response\" entry to see if this applies now.",
        inputSchema: z.object({
          jobId: z.string(),
          text: z.string().describe("Evidence/reasoning for the response, as markdown/plain text - pinned to IPFS automatically."),
        }),
      },
      async ({ jobId, text }) => {
        try {
          const result = await agent.respondToDispute(BigInt(jobId), { text });
          return json({ txHash: result.hash });
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    // -- Poster lifecycle ---------------------------------------------------------
    //
    // Until 0.6.0 this server was a worker's kit only, so an agent could earn
    // here but never hire: the only outside poster in ArcBounty's first mainnet
    // week was an agent operator, and he had to go around the MCP to do it.
    // Posting spends the configured wallet's USDC, hence the caps in limits.ts;
    // approving pays a worker out of escrow and is final, hence the checks
    // below, which turn a sure revert into a plain answer before any gas.

    let spentUsdc = 0;

    server.registerTool(
      "post_bounty",
      {
        description:
          `Post a new bounty on ${BRAND} from this server's configured wallet, paying the reward in USDC into ` +
          "escrow. Humans and AI agents can then take it; you review the work with get_bounty and pay with " +
          "approve_bounty (if you stay silent for 14 days after a submission, it pays out anyway). The reward " +
          `leaves this wallet now: on ${net.name} that is ${net.testnet ? "test money" : "real money"}. ` +
          `This server refuses a reward over ${limits.maxRewardUsdc} USDC and stops after ${limits.maxSpendUsdc} ` +
          "USDC per run (ARCBOUNTY_MAX_REWARD_USDC / ARCBOUNTY_MAX_SPEND_USDC, set by the operator). " +
          "Write a description a stranger can finish without asking you anything: the task, the acceptance " +
          "checks, and what to submit." + GAS_NOTE,
        inputSchema: z.object({
          title: z.string().min(1).max(140).describe("One line, shown as the bounty's heading."),
          description: z.string().min(1)
            .describe("Markdown body: what to do, how the result will be judged, and what to submit."),
          reward_usdc: z.number().min(1).describe("Reward in USDC, at least 1."),
          deadline_days: z.number().int().min(1).max(90).optional().describe("Days until the deadline (default 7)."),
          category: z.enum(["dev", "design", "content", "data", "other"]),
          tags: z.array(z.string()).max(10).optional(),
          agent_only: z.boolean().optional().describe("Only ERC-8004 registered agents may take it."),
          human_only: z.boolean().optional().describe("Only wallets without an agent identity may take it."),
        }),
      },
      async ({ title, description, reward_usdc, deadline_days, category, tags, agent_only, human_only }) => {
        if (agent_only && human_only) {
          return errorResult("agent_only and human_only exclude each other: set at most one of them.");
        }
        const overLimit = spendLimitError(reward_usdc, spentUsdc, limits);
        if (overLimit) return errorResult(overLimit);
        try {
          const balance = await agent.usdcBalance();
          if (balance < BigInt(Math.round(reward_usdc * 1e6))) {
            return errorResult(
              `This wallet (${agent.address}) holds ${agent.formatUsdc(balance)} USDC, less than the ` +
              `${reward_usdc} USDC reward.` + GAS_NOTE,
            );
          }
          const result = await agent.createBounty({
            rewardUsdc: reward_usdc,
            deadline: (deadline_days ?? 7) * 86_400,
            descriptionText: `# ${title}\n\n${description}`,
            category,
            tags: tags ?? [],
            agentOnly: agent_only ?? false,
            humanOnly: human_only ?? false,
          });
          spentUsdc = Math.round((spentUsdc + reward_usdc) * 1e6) / 1e6;
          const jobId = result.jobId?.toString() ?? null;
          return json({
            jobId,
            txHash: result.hash,
            url: jobId ? `https://${net.brand.domain}/bounty/${jobId}` : null,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "get_my_posted_bounties",
      {
        description:
          "List the bounties this server's configured wallet has posted, with their state: taken or not, " +
          "whether work was submitted (hasSubmission), resolved. Open one with get_bounty to read a submission.",
      },
      async () => {
        try {
          const posted = await agent.getPostedBounties();
          return json(posted.map(summarize));
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "approve_bounty",
      {
        description:
          "Approve the work submitted on a bounty this wallet posted: releases the escrowed USDC to the worker " +
          "(less the 1% fee) and, when the worker is an ERC-8004 agent, writes the score as its on-chain " +
          "reputation. Final: it cannot be undone. Read the submission with get_bounty first and approve only " +
          "work that meets the bounty's own acceptance checks. Work that misses them is rejected on the site, " +
          "where the worker gets 48 hours to challenge.",
        inputSchema: z.object({
          jobId: z.string(),
          score: z.number().int().min(0).max(100)
            .describe("0-100: how well the work met the spec. Recorded as reputation for agent workers."),
        }),
      },
      async ({ jobId, score }) => {
        try {
          const meta = await agent.getBounty(BigInt(jobId));
          if (meta.poster.toLowerCase() !== agent.address.toLowerCase()) {
            return errorResult(
              `Bounty ${jobId} was posted by ${meta.poster}, not by this wallet (${agent.address}); ` +
              "only its poster can approve it.",
            );
          }
          if (meta.resolved) return errorResult(`Bounty ${jobId} is already resolved.`);
          if (!meta.submittedResultHash) {
            return errorResult(`On bounty ${jobId} nothing has been submitted yet, so there is nothing to approve.`);
          }
          if (meta.inDispute || meta.rejectedAt > 0n) {
            return errorResult(
              `Bounty ${jobId} has a pending rejection or an open dispute; settle that on the site first.`,
            );
          }
          const result = await agent.approveBounty(BigInt(jobId), score);
          return json({ txHash: result.hash, paidTo: meta.assignedProvider });
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "cancel_bounty",
      {
        description:
          "Cancel a bounty this wallet posted that nobody has taken yet, refunding the full reward to this " +
          "wallet. Once a worker has taken it, it can no longer be cancelled.",
        inputSchema: z.object({ jobId: z.string() }),
      },
      async ({ jobId }) => {
        try {
          const meta = await agent.getBounty(BigInt(jobId));
          if (meta.poster.toLowerCase() !== agent.address.toLowerCase()) {
            return errorResult(
              `Bounty ${jobId} was posted by ${meta.poster}, not by this wallet (${agent.address}); ` +
              "only its poster can cancel it.",
            );
          }
          if (meta.resolved) return errorResult(`Bounty ${jobId} is already resolved.`);
          if (meta.isTaken) {
            return errorResult(`Bounty ${jobId} was already taken by ${meta.assignedProvider}, so it cannot be cancelled.`);
          }
          const result = await agent.cancelBounty(BigInt(jobId));
          return json({ txHash: result.hash, refundedUsdc: agent.formatUsdc(meta.reward) });
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  // Still NOT exposed: rejectBounty/disputeBounty/resolveDispute/
  // claimDefaultRuling/claimArbitratorTimeout. Rejecting real work, opening a
  // dispute and ruling on evidence are judgment calls that shouldn't be one
  // blind tool call away from an arbitrary MCP client - they stay in the full
  // SDK and on the site. approveBounty and cancelBounty left this list in
  // 0.6.0 (see "Poster lifecycle" above): approving only ever pays a worker
  // who delivered, and cancelling only refunds an untaken bounty to its poster.
  // challengeRejection/respondToDispute left it in V4.7 (M-03) as worker-side,
  // time-boxed self-defense.

  return server;
}
