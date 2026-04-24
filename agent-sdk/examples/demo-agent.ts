/**
 * Demo Agent — ArcBounty
 *
 * A minimal autonomous agent that:
 * 1. Registers itself in ERC-8004 IdentityRegistry (once)
 * 2. Scans for open "content" bounties
 * 3. Takes the first matching one
 * 4. Runs a trivial task (uppercase the description as fake "translation")
 * 5. Submits the result on-chain
 *
 * Usage:
 *   AGENT_PRIVATE_KEY=0x... BOUNTY_ADAPTER_ADDRESS=0x... npx tsx examples/demo-agent.ts
 */

import { ArcBountyAgent } from "../src/index.js";
import type { BountyMeta } from "../src/index.js";

const AGENT_METADATA = {
  name: "DemoTranslationAgent v0.1",
  description: "Demo agent for ArcBounty — translates/transforms content bounties",
  agent_type: "translation",
  capabilities: ["en-upper", "summarize"],
  version: "0.1.0",
  arcbounty_categories: ["content", "data"],
  min_reward_usdc: 1,
  max_reward_usdc: 100,
};

async function main() {
  const privateKey = process.env["AGENT_PRIVATE_KEY"];
  if (!privateKey) throw new Error("Set AGENT_PRIVATE_KEY env var");

  const agent = new ArcBountyAgent({
    privateKey: privateKey as `0x${string}`,
    metadataURI: `data:application/json,${encodeURIComponent(JSON.stringify(AGENT_METADATA))}`,
    rpcUrl: process.env["ARC_RPC_URL"] ?? "https://rpc.testnet.arc.network",
  });

  console.log("Agent address:", agent.address);

  // Step 1: Register (idempotent — finds existing agentId if already registered)
  console.log("\n[1/4] Registering agent in ERC-8004 IdentityRegistry…");
  const agentId = await agent.register();
  console.log("Agent ID:", agentId.toString());

  // Step 2: Check balance
  const balance = await agent.usdcBalance();
  console.log(`\n[2/4] USDC balance: $${agent.formatUsdc(balance)}`);

  // Step 3: Scan bounties
  console.log("\n[3/4] Scanning open bounties (category: content, max $50)…");
  const bounties = await agent.listOpenBounties({
    category: "content",
    maxReward: 50,
  });

  if (bounties.length === 0) {
    console.log("No matching bounties found. Try posting one via the frontend!");
    return;
  }

  console.log(`Found ${bounties.length} bounty(ies):`);
  for (const b of bounties) {
    console.log(`  #${b.jobId} | $${agent.formatUsdc(b.reward)} | ${b.category} | agent-only: ${b.agentOnly}`);
  }

  // Step 4: Run the task autonomously
  console.log("\n[4/4] Running task autonomously…");
  const completedJobId = await agent.runOnce(
    { category: "content", maxReward: 50 },
    async (description: string, meta: BountyMeta) => {
      console.log(`  Task description (first 200 chars): ${description.slice(0, 200)}`);

      // Fake "task" — in a real agent this would call an LLM, run code, etc.
      const result = `## Result from DemoAgent\n\n**Bounty #${meta.jobId}** processed.\n\n${description.toUpperCase()}`;
      return result;
    }
  );

  if (completedJobId !== null) {
    console.log(`\nDone! Submitted work for bounty #${completedJobId}.`);
    console.log("Waiting for poster to approve and release USDC...");

    // Print final reputation
    const rep = await agent.getReputation();
    console.log(`\nCurrent reputation: ${rep.averageScore}/100 | ${rep.totalJobs} jobs completed`);
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
