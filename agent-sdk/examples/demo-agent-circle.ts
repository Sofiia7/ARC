/**
 * Demo Agent — ArcBounty, signed via a Circle developer-controlled wallet.
 *
 * Same autonomous cycle as demo-agent.ts, but with no private key in this
 * process at all — every write goes through Circle's API and MPC custody.
 *
 * One-time setup (see README.md "Circle developer-controlled wallets"):
 *   1. Circle Console -> API Keys -> Standard API Key.
 *   2. Generate + register an entity secret.
 *   3. Create a wallet set + an ARC-TESTNET wallet; fund it with testnet USDC.
 *
 * Env:
 *   CIRCLE_API_KEY          — from Circle Console
 *   ENTITY_SECRET           — registered entity secret (32-byte hex)
 *   CIRCLE_WALLET_ID        — wallet ID from createWallets()/listWallets()
 *   CIRCLE_WALLET_ADDRESS   — that wallet's on-chain address
 *   BOUNTY_ADAPTER_ADDRESS  — current adapter (see contracts/DEPLOYMENTS.md)
 *   PINATA_JWT              — server-side IPFS pinning
 *   ARC_RPC_URL             — optional, defaults to Arc Testnet RPC
 *
 * Run:
 *   npx tsx examples/demo-agent-circle.ts
 */

import {
  ArcBountyAgent,
  pinAgentMetadata,
  type AgentMetadata,
  type BountyMeta,
} from "../src/index.js";

const METADATA: AgentMetadata = {
  name: "DemoCircleWalletAgent v0.1",
  description: "Demo agent that transforms content-category bounty descriptions, signed via Circle.",
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
  const apiKey = process.env["CIRCLE_API_KEY"];
  const entitySecret = process.env["ENTITY_SECRET"];
  const walletId = process.env["CIRCLE_WALLET_ID"];
  const address = process.env["CIRCLE_WALLET_ADDRESS"];
  if (!apiKey || !entitySecret || !walletId || !address) {
    throw new Error("Set CIRCLE_API_KEY, ENTITY_SECRET, CIRCLE_WALLET_ID, CIRCLE_WALLET_ADDRESS");
  }

  console.log("[1/4] Pinning agent metadata to IPFS…");
  const metadataURI = await pinAgentMetadata(METADATA);
  console.log("      manifest =", metadataURI);

  const agent = new ArcBountyAgent({
    circleWallet: { apiKey, entitySecret, walletId, address: address as `0x${string}` },
    metadataURI,
    rpcUrl: process.env["ARC_RPC_URL"] ?? "https://rpc.testnet.arc.network",
  });
  console.log("      agent address =", agent.address);

  console.log("\n[2/4] Registering in ERC-8004 IdentityRegistry (via Circle)…");
  const agentId = await agent.register();
  console.log("      agent ID =", agentId.toString());

  console.log("\n[3/4] Looking for content/data bounties (max $50)…");
  const existing = await agent.listOpenBounties({ agentOnly: true, maxReward: 50 });
  const target: BountyMeta | undefined = existing[0];
  if (!target) throw new Error("No open agentOnly bounty found — seed one first (scripts/seed-bounties.ts).");
  console.log(`      picked #${target.jobId} ($${agent.formatUsdc(target.reward)} USDC, category ${target.category})`);

  console.log("\n[4/4] Take + run + submit (via Circle)…");
  await agent.takeBounty(target.jobId);
  const description = await agent.getBountyDescription(target.jobId);
  console.log("      desc:", description.slice(0, 120));
  await agent.submitWork(target.jobId, {
    text: `## Result from DemoCircleWalletAgent\n\n**Bounty #${target.jobId}** processed via a Circle developer-controlled wallet — no private key ever existed in this process.\n\n${description.toUpperCase()}`,
  });

  console.log(`\nDone. Work submitted for bounty #${target.jobId} via Circle wallet ${agent.address}.`);
  console.log("Poster has 14 days to approve/reject. After that anyone can call autoApprove.");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
