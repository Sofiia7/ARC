import { describe, expect, it, afterEach } from "vitest";
import { ArcBountyAgent } from "../src/ArcBountyAgent.js";

// A throwaway key: these tests never sign or broadcast anything. The
// constructor does no network I/O, so everything below runs offline.
const KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ADAPTER = "0x9b0B27c20DF10BFc667F4316d7175166Ff8c4c2c";

function agent(extra: Record<string, unknown> = {}) {
  return new ArcBountyAgent({
    network: "base-mainnet",
    privateKey: KEY,
    bountyAdapterAddress: ADAPTER,
    ...extra,
  } as ConstructorParameters<typeof ArcBountyAgent>[0]);
}

afterEach(() => {
  delete process.env["AGENT_ID"];
});

describe("pinned agentId", () => {
  it("accepts a decimal string, a number and a bigint", () => {
    expect(agent({ agentId: "83995" }).agentId).toBe(83995n);
    expect(agent({ agentId: 83995 }).agentId).toBe(83995n);
    expect(agent({ agentId: 83995n }).agentId).toBe(83995n);
  });

  it("falls back to the AGENT_ID environment variable", () => {
    process.env["AGENT_ID"] = "83995";
    expect(agent().agentId).toBe(83995n);
  });

  it("lets an explicit config value win over the environment", () => {
    process.env["AGENT_ID"] = "1";
    expect(agent({ agentId: 83995 }).agentId).toBe(83995n);
  });

  it("ignores an empty or whitespace-only AGENT_ID rather than throwing", () => {
    process.env["AGENT_ID"] = "   ";
    expect(() => agent().agentId).toThrow(/not resolved in this process/);
  });

  it("rejects a non-numeric id", () => {
    expect(() => agent({ agentId: "not-a-number" })).toThrow(/invalid agentId/);
  });

  it("rejects zero, which means \"no agent\" on-chain", () => {
    expect(() => agent({ agentId: 0 })).toThrow(/must be positive/);
    expect(() => agent({ agentId: -5 })).toThrow(/must be positive/);
  });
});

describe("agentId getter", () => {
  // The regression this guards: the getter used to say "Agent not registered",
  // which is a claim about the CHAIN. It is really a claim about this process's
  // cache, and it was returned verbatim by the MCP server's get_agent_info for
  // a wallet that demonstrably owned an identity.
  it("does not claim the wallet is unregistered when it simply has not looked", () => {
    let message = "";
    try {
      agent().agentId;
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not resolved in this process/);
    expect(message).toMatch(/resolveAgentId/);
    expect(message).not.toMatch(/not registered/i);
  });

  it("is cleared by setAgentId so the new id gets re-verified", () => {
    const a = agent({ agentId: 1n });
    a.setAgentId(2n);
    expect(a.agentId).toBe(2n);
  });
});
