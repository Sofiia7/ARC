// lib/agentIds.ts: which ERC-8004 identities a wallet holds (incident 2026-11-09: on Base the
// one 500,000-block getLogs these pages used was refused by every default RPC, the error was
// swallowed and a wallet that already had an agent looked like it had none).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, type Address, type PublicClient } from "viem";
import { findOwnedAgentIds, type AgentIdLookupOptions } from "../lib/agentIds";
import { resolveNetwork } from "../lib/networks";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;
const OWNER = "0x00000000000000000000000000000000000000b0" as Address;
const OTHER = "0x00000000000000000000000000000000000000aa" as Address;

type Fake = {
  balance: bigint | Error;
  head?: bigint;
  transfers?: [block: bigint, tokenId: bigint][];
  owners?: Map<bigint, Address>;
};

function fakeClient(f: Fake) {
  const getLogsCalls: { fromBlock: bigint; toBlock: bigint; args: unknown }[] = [];
  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === "balanceOf") {
        if (f.balance instanceof Error) throw f.balance;
        return f.balance;
      }
      if (functionName === "ownerOf") return f.owners?.get(args[0] as bigint) ?? OWNER;
      throw new Error(`unexpected ${functionName}`);
    },
    getBlockNumber: async () => f.head ?? 5_000_000n,
    getLogs: async (p: { fromBlock: bigint; toBlock: bigint; args: unknown }) => {
      getLogsCalls.push(p);
      return (f.transfers ?? [])
        .filter(([b]) => b >= p.fromBlock && b <= p.toBlock)
        .map(([b, tokenId]) => ({ blockNumber: b, args: { from: OTHER, to: OWNER, tokenId } }));
    },
  };
  return { client: client as unknown as PublicClient, getLogsCalls };
}

function explorer(logs: [block: bigint, tokenId: bigint][] | { status: number }) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    if (!Array.isArray(logs)) return new Response("blocked", { status: logs.status });
    return Response.json({
      status: "1",
      result: logs.map(([b, id]) => ({
        blockNumber: `0x${b.toString(16)}`,
        topics: ["0xddf252ad", pad(OTHER, { size: 32 }), pad(OWNER, { size: 32 }), `0x${id.toString(16).padStart(64, "0")}`],
      })),
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const opts = (extra: Partial<AgentIdLookupOptions> = {}): AgentIdLookupOptions =>
  ({ registry: REGISTRY, maxLogRange: 50_000n, maxCalls: 24, ...extra });

test("a wallet with no identity is answered by balanceOf alone: no explorer call, no log scan", async () => {
  const { client, getLogsCalls } = fakeClient({ balance: 0n });
  const ex = explorer([]);
  assert.deepEqual(await findOwnedAgentIds(client, OWNER, opts({ explorerApiUrl: "https://x.test/api", fetchImpl: ex.fetchImpl })), { owned: 0n, ids: [] });
  assert.equal(ex.urls.length, 0);
  assert.equal(getLogsCalls.length, 0);
});

test("ids come from the explorer filtered by recipient, and ownerOf drops the ones sent away", async () => {
  const { client, getLogsCalls } = fakeClient({ balance: 1n, owners: new Map([[9n, OTHER]]) });
  const ex = explorer([[10n, 5n], [20n, 9n]]);
  const r = await findOwnedAgentIds(client, OWNER, opts({ explorerApiUrl: "https://base.blockscout.test/api", fetchImpl: ex.fetchImpl }));
  assert.deepEqual(r, { owned: 1n, ids: [5n] });
  assert.equal(getLogsCalls.length, 0);
  assert.match(ex.urls[0]!, /^https:\/\/base\.blockscout\.test\/api\?module=logs&action=getLogs&fromBlock=0&toBlock=latest/);
  assert.ok(ex.urls[0]!.includes(`&topic2=${pad(OWNER.toLowerCase() as Address, { size: 32 })}&topic0_2_opr=and`));
});

test("an empty explorer answer is not trusted: Blockscout's index has gaps, so the RPC scan tops it up", async () => {
  // Live 2026-11-09: Blockscout returned [] for a wallet that had received #1174529 an hour
  // earlier; the blocks were simply missing from its index.
  const { client, getLogsCalls } = fakeClient({ balance: 1n, head: 5_000_000n, transfers: [[4_990_000n, 1174529n]] });
  const ex = explorer([]);
  const r = await findOwnedAgentIds(client, OWNER, opts({ explorerApiUrl: "https://x.test/api", fetchImpl: ex.fetchImpl }));
  assert.deepEqual(r, { owned: 1n, ids: [1174529n] });
  assert.equal(ex.urls.length, 1);
  assert.ok(getLogsCalls.length > 0);
});

test("explorer and RPC results are merged, each id once, oldest first", async () => {
  const { client } = fakeClient({ balance: 2n, head: 5_000_000n, transfers: [[4_990_000n, 9n]] });
  const ex = explorer([[100n, 3n], [4_990_000n, 9n]]);
  const owners = new Map<bigint, Address>([[3n, OTHER]]);
  const c = fakeClient({ balance: 2n, head: 5_000_000n, owners, transfers: [[4_990_000n, 9n], [4_995_000n, 11n]] });
  assert.deepEqual((await findOwnedAgentIds(client, OWNER, opts({ explorerApiUrl: "https://x.test/api", fetchImpl: ex.fetchImpl }))).ids, [3n, 9n]);
  assert.deepEqual((await findOwnedAgentIds(c.client, OWNER, opts({ explorerApiUrl: "https://x.test/api", fetchImpl: ex.fetchImpl }))).ids, [9n, 11n]);
});

test("an explorer URL that already has a query string gets & not a second ?", async () => {
  const { client } = fakeClient({ balance: 1n });
  const ex = explorer([[10n, 5n]]);
  await findOwnedAgentIds(client, OWNER, opts({ explorerApiUrl: "https://api.etherscan.test/v2/api?chainid=84532", fetchImpl: ex.fetchImpl }));
  assert.match(ex.urls[0]!, /\?chainid=84532&module=logs/);
});

test("when the explorer refuses, a bounded RPC scan in maxLogRange chunks finds the id", async () => {
  const { client, getLogsCalls } = fakeClient({ balance: 1n, head: 5_000_000n, transfers: [[4_400_000n, 77n]] });
  const ex = explorer({ status: 403 });
  const r = await findOwnedAgentIds(client, OWNER, opts({ explorerApiUrl: "https://x.test/api", fetchImpl: ex.fetchImpl }));
  assert.deepEqual(r, { owned: 1n, ids: [77n] });
  assert.ok(getLogsCalls.length <= 24);
  for (const c of getLogsCalls) {
    assert.ok(c.toBlock - c.fromBlock + 1n <= 50_000n, "never wider than maxLogRange");
    assert.deepEqual(c.args, { to: OWNER });
  }
});

test("Base Sepolia's 200-block cap and the call budget bound the RPC scan", async () => {
  const { client, getLogsCalls } = fakeClient({ balance: 1n, head: 1_000_000n });
  const r = await findOwnedAgentIds(client, OWNER, opts({ maxLogRange: 200n }));
  assert.deepEqual(r, { owned: 1n, ids: [] }, "holds one, could not locate it: the caller warns instead of saying none");
  assert.equal(getLogsCalls.length, 24);
  for (let i = 0; i < getLogsCalls.length; i++) {
    const c = getLogsCalls[i]!;
    assert.ok(c.toBlock - c.fromBlock + 1n <= 200n);
    if (i > 0) assert.equal(c.toBlock, getLogsCalls[i - 1]!.fromBlock - 1n, "contiguous, newest first");
  }
});

test("several identities come back oldest first, the newest last (the primary)", async () => {
  const { client } = fakeClient({ balance: 2n });
  const ex = explorer([[30n, 3n], [10n, 1n], [20n, 2n]]);
  const owners = new Map<bigint, Address>([[2n, OTHER]]);
  const c2 = fakeClient({ balance: 2n, owners });
  assert.deepEqual((await findOwnedAgentIds(client, OWNER, opts({ explorerApiUrl: "https://x.test/api", fetchImpl: ex.fetchImpl }))).ids, [2n, 3n]);
  assert.deepEqual((await findOwnedAgentIds(c2.client, OWNER, opts({ explorerApiUrl: "https://x.test/api", fetchImpl: ex.fetchImpl }))).ids, [1n, 3n]);
});

test("an unreadable balance still falls back to the logs", async () => {
  const { client } = fakeClient({ balance: new Error("429") });
  const ex = explorer([[10n, 5n]]);
  assert.deepEqual(await findOwnedAgentIds(client, OWNER, opts({ explorerApiUrl: "https://x.test/api", fetchImpl: ex.fetchImpl })), { owned: null, ids: [5n] });
});

test("Base networks carry the log range their RPCs actually serve", () => {
  assert.equal(resolveNetwork("base-mainnet").maxLogRange, 50_000n);
  assert.equal(resolveNetwork("base-sepolia").maxLogRange, 200n);
  assert.equal(resolveNetwork("arc-mainnet").maxLogRange, undefined);
});
