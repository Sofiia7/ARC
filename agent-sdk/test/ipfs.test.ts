import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPinningConfigured } from "../src/ipfs.js";

const ENV_KEYS = ["PINATA_JWT", "PINATA_API_KEY", "PINATA_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("isPinningConfigured", () => {
  it("is false with no Pinata credentials set", () => {
    expect(isPinningConfigured()).toBe(false);
  });

  it("is true with just a JWT", () => {
    process.env["PINATA_JWT"] = "test-jwt";
    expect(isPinningConfigured()).toBe(true);
  });

  it("is true with an API key + secret pair", () => {
    process.env["PINATA_API_KEY"] = "key";
    process.env["PINATA_SECRET"] = "secret";
    expect(isPinningConfigured()).toBe(true);
  });

  it("is false with only a key OR only a secret, not both", () => {
    process.env["PINATA_API_KEY"] = "key";
    expect(isPinningConfigured()).toBe(false);
    delete process.env["PINATA_API_KEY"];
    process.env["PINATA_SECRET"] = "secret";
    expect(isPinningConfigured()).toBe(false);
  });
});
