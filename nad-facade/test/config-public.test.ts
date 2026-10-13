import { test } from "node:test";
import assert from "node:assert/strict";
import { configuration } from "../src/config.js";

const treasury = "0x74678c072Ca546f11466CD44eB7e21730a312a54";
const adapter = "0x5C38F98Fb3F3BA3eB8206Cb653eeDC8C159E1bE4";
const mainnet = { NAD_NETWORK: "monad-mainnet", NAD_BOUNTY_ADAPTER_ADDRESS: adapter, NAD_X402_PAY_TO: treasury };

test("public URL: mainnet defaults to the hosted facade, testnet to the local listener", () => {
  assert.equal(configuration(mainnet).publicUrl, "https://nadbounty-facade.vercel.app");
  assert.equal(configuration({ NAD_X402_PAY_TO: treasury, PORT: "4000" }).publicUrl, "http://127.0.0.1:4000");
});

test("public URL: override must be an https origin (plain http only for a local address)", () => {
  assert.equal(
    configuration({ ...mainnet, NAD_PUBLIC_URL: "https://facade.example.org/" }).publicUrl,
    "https://facade.example.org",
  );
  assert.equal(
    configuration({ ...mainnet, NAD_PUBLIC_URL: "http://localhost:3402" }).publicUrl,
    "http://localhost:3402",
  );
  for (const bad of [
    "http://facade.example.org",
    "https://facade.example.org/api",
    "https://facade.example.org/?x=1",
    "ftp://x",
    "nonsense",
    "https://user:pw@facade.example.org",
  ]) {
    assert.throws(() => configuration({ ...mainnet, NAD_PUBLIC_URL: bad }), Error, bad);
  }
});

test("rate limit: 60 per minute by default, bounded integer override", () => {
  assert.equal(configuration(mainnet).rateLimitPerMinute, 60);
  assert.equal(configuration({ ...mainnet, NAD_RATE_LIMIT_PER_MINUTE: "120" }).rateLimitPerMinute, 120);
  for (const bad of ["0", "-1", "1.5", "abc", "6001"]) {
    assert.throws(() => configuration({ ...mainnet, NAD_RATE_LIMIT_PER_MINUTE: bad }), /rate limit/i, bad);
  }
});
