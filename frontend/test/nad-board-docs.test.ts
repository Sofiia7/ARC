import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FACADE_URLS,
  MCP_PACKAGE,
  OWNER_VS_WORKING_WALLET,
  SDK_PACKAGE,
  TIMING,
  TIMING_SECONDS,
  mcpConfig,
  sdkSnippet,
  timingFacts,
} from "../lib/nadBoardDocs";

// npm test runs from frontend/, so the Solidity source sits at ../contracts. Skipped where the repo has no contracts.
const SOURCE = join(process.cwd(), "..", "contracts", "src", "monad", "BountyAdapterV48.sol");
const solidity = existsSync(SOURCE) ? readFileSync(SOURCE, "utf8") : null;

function constant(name: string): string {
  const match = new RegExp(`constant\\s+${name}\\s*=\\s*([^;]+);`).exec(solidity ?? "");
  assert.ok(match, `${name} not found in BountyAdapterV48.sol`);
  return match[1].replace(/\/\/.*$/, "").trim();
}
const days = (expr: string) => {
  const m = /^(\d+)\s+days$/.exec(expr);
  assert.ok(m, `not a days literal: ${expr}`);
  return Number(m[1]);
};
const hours = (expr: string) => {
  const m = /^(\d+)\s+hours$/.exec(expr);
  assert.ok(m, `not an hours literal: ${expr}`);
  return Number(m[1]);
};

test("timings on /start match the contract constants", { skip: solidity === null }, () => {
  assert.equal(days(constant("APPROVAL_TIMEOUT")), TIMING.reviewWindowDays);
  assert.equal(days(constant("ARBITRATOR_TIMEOUT")), TIMING.arbitratorDays);
  assert.equal(hours(constant("REJECTION_CHALLENGE_WINDOW")) / 24, TIMING.rejectionChallengeDays);
  assert.equal(hours(constant("DISPUTE_RESPONSE_WINDOW")) / 24, TIMING.disputeResponseDays);
  assert.equal(Number(constant("WORKER_BOND_BPS").split("//")[0]) / 100, TIMING.workerBondPercent);
  // 0.5e6 base units is 0.50 USDC; 1e6 is the 1 USDC minimum reward.
  assert.equal(Number(constant("MIN_WORKER_BOND")) / 1e6, Number(TIMING.workerBondFloorUsdc));
  assert.equal(Number(constant("MIN_REWARD")) / 1e6, TIMING.minRewardUsdc);
});

test("seconds constants are the day counts", () => {
  assert.equal(TIMING_SECONDS.reviewWindow, 1_209_600);
  assert.equal(TIMING_SECONDS.rejectionChallenge, 172_800);
  assert.equal(TIMING_SECONDS.disputeResponse, 172_800);
  assert.equal(TIMING_SECONDS.arbitrator, 2_592_000);
});

test("the MCP config is valid JSON for the Monad server and carries no secret", () => {
  const config = JSON.parse(mcpConfig("monad-mainnet"));
  assert.deepEqual(config.mcpServers.nadbounty, {
    command: "npx",
    args: ["-y", "nadbounty-mcp"],
    env: { NAD_NETWORK: "monad-mainnet" },
  });
  assert.equal(MCP_PACKAGE, "nadbounty-mcp");
  assert.equal(mcpConfig("monad-testnet").includes("NAD_PRIVATE_KEY"), false);
  assert.equal(JSON.parse(mcpConfig("monad-testnet")).mcpServers.nadbounty.env.NAD_NETWORK, "monad-testnet");
});

test("the SDK snippet uses the documented class only, and mainnet has no address override", () => {
  const main = sdkSnippet("monad-mainnet", 1n);
  assert.match(main, /import \{ NadBountyAgent \} from "arcbounty-agent-sdk";/);
  assert.match(main, /network: "monad-mainnet"/);
  assert.equal(main.includes("bountyAdapterAddress"), false);
  assert.match(main, /agent\.getBounty\(1n\)/);
  assert.equal(SDK_PACKAGE, "arcbounty-agent-sdk");
  const testnet = sdkSnippet("monad-testnet", 7n, "0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020");
  assert.match(testnet, /bountyAdapterAddress: "0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020"/);
});

test("no pinned package versions in the snippets", () => {
  const all = [mcpConfig("monad-mainnet"), sdkSnippet("monad-mainnet", 1n), OWNER_VS_WORKING_WALLET].join("\n");
  assert.equal(/nadbounty-mcp@|arcbounty-agent-sdk@/.test(all), false);
});

test("the timing facts state every constant and use plain hyphens", () => {
  const text = timingFacts()
    .map((f) => `${f.label}: ${f.text}`)
    .join("\n");
  for (const needle of ["1%", "14 days", "2 days", "30 days", "15%", "0.50 USDC", "MON"])
    assert.ok(text.includes(needle), needle);
  // The house rule: no en or em dashes anywhere in shipped text.
  const everything = [text, OWNER_VS_WORKING_WALLET, mcpConfig("monad-mainnet"), FACADE_URLS.mainnet].join("\n");
  const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
  assert.equal(dashes.test(everything), false);
});
