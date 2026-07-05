import { describe, it, expect } from "vitest";
import { validateAgentMetadata, type AgentMetadata } from "../src/metadata.js";

const VALID: AgentMetadata = {
  name: "summariser-bot",
  description: "Summarises long-form content bounties.",
  agent_type: "translation",
  capabilities: ["en-ru", "summarize"],
  version: "1.0.0",
  contact: "https://myagent.xyz",
  arcbounty: {
    min_reputation: 70,
    preferred_categories: ["content", "data"],
    min_reward_usdc: 1,
    max_reward_usdc: 100,
  },
};

describe("validateAgentMetadata", () => {
  it("accepts a fully-populated valid manifest", () => {
    expect(() => validateAgentMetadata(VALID)).not.toThrow();
  });

  it("accepts the minimal required shape (name + description only)", () => {
    expect(() => validateAgentMetadata({ name: "x", description: "" })).not.toThrow();
  });

  it("rejects a non-object", () => {
    expect(() => validateAgentMetadata(null)).toThrow(/must be an object/);
    expect(() => validateAgentMetadata("not an object")).toThrow(/must be an object/);
  });

  it("rejects a missing or empty name", () => {
    expect(() => validateAgentMetadata({ description: "x" })).toThrow(/name/);
    expect(() => validateAgentMetadata({ name: "", description: "x" })).toThrow(/name/);
  });

  it("rejects a non-string description", () => {
    expect(() => validateAgentMetadata({ name: "x", description: 123 })).toThrow(/description/);
  });

  it("rejects capabilities that isn't an array", () => {
    expect(() => validateAgentMetadata({ name: "x", description: "", capabilities: "not-an-array" }))
      .toThrow(/capabilities/);
  });

  it("rejects an out-of-range min_reputation", () => {
    expect(() => validateAgentMetadata({ ...VALID, arcbounty: { min_reputation: 101 } }))
      .toThrow(/min_reputation/);
    expect(() => validateAgentMetadata({ ...VALID, arcbounty: { min_reputation: -1 } }))
      .toThrow(/min_reputation/);
  });

  it("rejects an invalid category in preferred_categories", () => {
    expect(() => validateAgentMetadata({ ...VALID, arcbounty: { preferred_categories: ["not-a-real-category"] } }))
      .toThrow(/invalid category/);
  });

  it("rejects a negative min_reward_usdc / max_reward_usdc", () => {
    expect(() => validateAgentMetadata({ ...VALID, arcbounty: { min_reward_usdc: -5 } }))
      .toThrow(/min_reward_usdc/);
    expect(() => validateAgentMetadata({ ...VALID, arcbounty: { max_reward_usdc: -1 } }))
      .toThrow(/max_reward_usdc/);
  });
});
