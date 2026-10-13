import test from "node:test";
import assert from "node:assert/strict";
import {
  agentCacheKey,
  controlledAgents,
  controlsAgent,
  legacyAgentCacheKey,
  mergeAgentIds,
  missingOwnedCount,
  parseAgentIdInput,
  parseAgentIdList,
  serializeAgentIds,
} from "../lib/nadAgents";

const ME = "0x00000000000000000000000000000000000000AA";
const OTHER = "0x00000000000000000000000000000000000000bb";
const ZERO = "0x0000000000000000000000000000000000000000";

test("cache keys are per chain and per lower-cased wallet, and keep the Arc/Base key readable", () => {
  assert.equal(agentCacheKey(143, ME), "nadbounty:agentIds:143:0x00000000000000000000000000000000000000aa");
  assert.equal(legacyAgentCacheKey(143, ME), "arcbounty:agentIds:143:0x00000000000000000000000000000000000000aa");
  assert.notEqual(agentCacheKey(143, ME), agentCacheKey(10143, ME));
});

test("merging: positive ids only, no duplicates, ascending", () => {
  assert.deepEqual(mergeAgentIds([9n, 3n], [3n, 0n, 12n], [-4n]), [3n, 9n, 12n]);
  assert.deepEqual(mergeAgentIds(), []);
});

test("stored lists survive junk: anything unreadable becomes an empty list or loses only the bad items", () => {
  assert.deepEqual(parseAgentIdList(null), []);
  assert.deepEqual(parseAgentIdList(undefined), []);
  assert.deepEqual(parseAgentIdList(""), []);
  assert.deepEqual(parseAgentIdList("not json"), []);
  assert.deepEqual(parseAgentIdList('{"a":1}'), []);
  assert.deepEqual(parseAgentIdList('["12","x","-3","0","7",8,1.5,null,{"a":1},"9999999999999999999999"]'), [
    7n,
    8n,
    12n,
    9999999999999999999999n,
  ]);
  assert.deepEqual(parseAgentIdList(serializeAgentIds([5n, 2n, 5n])), [2n, 5n]);
  assert.equal(serializeAgentIds([]), "[]");
});

test("the cache never grows past its cap", () => {
  const many = Array.from({ length: 500 }, (_, i) => BigInt(i + 1));
  assert.equal(mergeAgentIds(many).length, 200);
});

test("typed agent ids", () => {
  assert.deepEqual(parseAgentIdInput("42"), { ok: true, id: 42n });
  assert.deepEqual(parseAgentIdInput(" #42 "), { ok: true, id: 42n });
  const zero = parseAgentIdInput("0");
  assert.equal(zero.ok, false);
  if (!zero.ok) assert.match(zero.error, /Me \(wallet\)/);
  for (const bad of ["", "abc", "-1", "1.5", "0x10", "1e3", "12 13"]) {
    const result = parseAgentIdInput(bad);
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.match(result.error, /whole number/);
  }
});

test("control: identity owner or registered working wallet, as the adapter checks", () => {
  assert.equal(controlsAgent(ME, OTHER, ME.toLowerCase()), true);
  assert.equal(controlsAgent(OTHER, ME, ME), true);
  assert.equal(controlsAgent(OTHER, OTHER, ME), false);
  assert.equal(controlsAgent(null, null, ME), false);
  // An unset working wallet is the zero address, which nobody controls.
  assert.equal(controlsAgent(OTHER, ZERO, ZERO), false);
});

test("controlled agents split owned from working-wallet-only", () => {
  const checks = [
    { id: 1n, owner: ME, wallet: ME },
    { id: 2n, owner: OTHER, wallet: ME },
    { id: 3n, owner: OTHER, wallet: OTHER },
    { id: 4n, owner: null, wallet: null },
  ];
  assert.deepEqual(controlledAgents(checks, ME), [
    { id: 1n, isOwner: true },
    { id: 2n, isOwner: false },
  ]);
});

test("missing owned agents: balanceOf minus what was found, never negative", () => {
  assert.equal(missingOwnedCount(undefined, 0), 0);
  assert.equal(missingOwnedCount(3, 1), 2);
  assert.equal(missingOwnedCount(1, 3), 0);
  assert.equal(missingOwnedCount(0, 0), 0);
});
