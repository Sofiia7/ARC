/**
 * Demo Agent — ArcBounty
 *
 * Runs the full autonomous cycle:
 *   1. Pin agent metadata to IPFS (real CID, persistent — never data:).
 *   2. Register in ERC-8004 IdentityRegistry (idempotent).
 *   3. Subscribe to BountyCreated, pick the first matching new bounty.
 *   4. Take it, run the task, submit the result.
 *
 * Env:
 *   AGENT_PRIVATE_KEY      — agent wallet (0x...)
 *   BOUNTY_ADAPTER_ADDRESS — current adapter (see contracts/DEPLOYMENTS.md)
 *   PINATA_JWT             — server-side IPFS pinning
 *   ARC_RPC_URL            — optional, defaults to Arc Testnet RPC
 *
 * Run:
 *   npx tsx examples/demo-agent.ts
 */

import {
  ArcBountyAgent,
  pinAgentMetadata,
  type AgentMetadata,
  type BountyMeta,
} from "../src/index.js";

const METADATA: AgentMetadata = {
  name: "DemoTranslationAgent v0.1",
  description: "Demo agent that transforms content-category bounty descriptions.",
  agent_type: "translation",
  capabilities: ["en-upper", "summarize"],
  version: "0.1.0",
  arcbounty: {
    min_reputation: 0,
    preferred_categories: ["content", "data"],
    min_reward_usdc: 1,
    max_reward_usdc: 100,
  },
};

async function main() {
  const privateKey = process.env["AGENT_PRIVATE_KEY"];
  if (!privateKey) throw new Error("Set AGENT_PRIVATE_KEY env var");

  // 1. Pin the manifest. Validates against the schema first.
  console.log("[1/4] Pinning agent metadata to IPFS…");
  const metadataURI = await pinAgentMetadata(METADATA);
  console.log("      manifest =", metadataURI);

  const agent = new ArcBountyAgent({
    privateKey:    privateKey as `0x${string}`,
    metadataURI,
    rpcUrl:        process.env["ARC_RPC_URL"] ?? "https://rpc.testnet.arc.network",
  });
  console.log("      agent address =", agent.address);

  // 2. Register (idempotent — finds existing tokenId if already minted).
  console.log("\n[2/4] Registering in ERC-8004 IdentityRegistry…");
  const agentId = await agent.register();
  console.log("      agent ID =", agentId.toString());

  // 3. Either take a pre-existing open bounty, or wait for the next match.
  console.log("\n[3/4] Looking for content bounties (max $50)…");
  const existing = await agent.listOpenBounties({ category: "content", maxReward: 50 });
  let target: BountyMeta | undefined = existing[0];

  if (!target) {
    console.log("      none open — subscribing for the next match (5min)…");
    target = await new Promise<BountyMeta>((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error("no matching bounty in 5 minutes")); }, 5 * 60_000);
      const stop = agent.subscribeToNewBounties(
        { category: "content", maxReward: 50 },
        meta => { clearTimeout(timeout); stop(); resolve(meta); },
      );
    });
  }
  console.log(`      picked #${target.jobId} ($${agent.formatUsdc(target.reward)} USDC)`);

  // 4. Take → run task off-chain → submit result.
  console.log("\n[4/4] Take + run + submit…");
  await agent.runOnce(
    { category: "content", maxReward: 50 },
    async (description, meta) => {
      console.log("      desc:", description.slice(0, 120));
      return `## Result from DemoAgent\n\n**Bounty #${meta.jobId}** processed.\n\n${description.toUpperCase()}`;
    },
  );

  const rep = await agent.getReputation();
  console.log(`\nDone. Reputation: ${rep.averageScore}/100 over ${rep.totalJobs} job(s).`);
  console.log("Poster has 14 days to approve/reject. After that anyone can call autoApprove.");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
