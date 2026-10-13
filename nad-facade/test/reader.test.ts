import { test } from "node:test";
import assert from "node:assert/strict";
import { ChainReader } from "../src/reader.js";
import { POSTER, fakeChain, mainnetConfig, meta } from "./helpers.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const reads = (chain: ReturnType<typeof fakeChain>, name: string) => chain.log.calls.filter((c) => c === name).length;

test("existence check: a job above the highest known ID costs no per-job read", async () => {
  const chain = fakeChain();
  const reader = new ChainReader(chain, mainnetConfig(), clock().now);
  assert.equal(await reader.lookupJob(999n), undefined);
  assert.equal(reads(chain, "getBountyMeta"), 0);
  assert.equal(reads(chain, "totalBounties"), 1);
  assert.equal(reads(chain, "allJobIds"), 1);
});

test("existence check: a real job costs one read ever, even under concurrent probes", async () => {
  const chain = fakeChain();
  const reader = new ChainReader(chain, mainnetConfig(), clock().now);
  const results = await Promise.all(Array.from({ length: 20 }, () => reader.lookupJob(2n)));
  assert.ok(results.every((info) => info?.contest === true));
  assert.equal(reads(chain, "getBountyMeta"), 1);
  await reader.lookupJob(2n);
  assert.equal(reads(chain, "getBountyMeta"), 1, "the hit is remembered");
  assert.equal((await reader.lookupJob(1n))?.contest, false);
});

test("existence check: the highest ID is cached for 15 s and rechecked at most every 2 s for a new job", async () => {
  const time = clock();
  const chain = fakeChain();
  const reader = new ChainReader(chain, mainnetConfig(), time.now);
  assert.equal(await reader.lookupJob(6n), undefined); // not created yet
  assert.equal(reads(chain, "totalBounties"), 1);

  // The bounty is created right after.
  chain.world.metas.set(6n, meta({ jobId: 6n, poster: POSTER, reward: 1_000_000n }));
  chain.world.jobIds.push(6n);
  chain.world.total = 6n;

  time.advance(500);
  assert.equal(await reader.lookupJob(6n), undefined, "the miss is remembered for 5 s");
  time.advance(5000);
  // 5.5 s later the miss expired and the cached maximum is older than 2 s: one bounded refresh finds the new job.
  assert.equal((await reader.lookupJob(6n))?.contest, false);
  assert.equal(reads(chain, "totalBounties"), 2);
});

test("existence check: probing many unknown IDs in a burst triggers at most one refresh", async () => {
  const time = clock();
  const chain = fakeChain();
  const reader = new ChainReader(chain, mainnetConfig(), time.now);
  await reader.lookupJob(100n);
  time.advance(2500);
  await Promise.all(Array.from({ length: 50 }, (_, i) => reader.lookupJob(BigInt(200 + i))));
  assert.equal(reads(chain, "totalBounties"), 2, "one initial load plus one shared refresh");
  assert.equal(reads(chain, "getBountyMeta"), 0);
});

test("pinned block: shared for 5 s, then renewed", async () => {
  const time = clock();
  const chain = fakeChain();
  const reader = new ChainReader(chain, mainnetConfig(), time.now);
  await Promise.all([reader.pinned(), reader.pinned(), reader.pinned()]);
  assert.equal(chain.log.blocks, 1);
  time.advance(4999);
  await reader.pinned();
  assert.equal(chain.log.blocks, 1);
  time.advance(2);
  await reader.pinned();
  assert.equal(chain.log.blocks, 2);
});

test("reads for one answer all use the block that is reported", async () => {
  const chain = fakeChain();
  const seen: Array<bigint | undefined> = [];
  const original = chain.call.bind(chain);
  chain.call = async (calls, blockNumber) => {
    seen.push(blockNumber);
    return original(calls, blockNumber);
  };
  const reader = new ChainReader(chain, mainnetConfig(), clock().now);
  const body = await reader.reputationSnapshot(10388n);
  assert.equal(body?.sourceBlock, chain.block.number);
  // First call reads the immutables at latest; every read of the answer itself is pinned.
  assert.deepEqual(seen.slice(1), [chain.block.number, chain.block.number]);
});

test("an unknown agent is remembered as missing for 15 s", async () => {
  const time = clock();
  const chain = fakeChain();
  const reader = new ChainReader(chain, mainnetConfig(), time.now);
  assert.equal(reader.isKnownMissingAgent(42n), false);
  assert.equal(await reader.reputationSnapshot(42n), undefined);
  assert.equal(reader.isKnownMissingAgent(42n), true);
  time.advance(15_001);
  assert.equal(reader.isKnownMissingAgent(42n), false);
});
