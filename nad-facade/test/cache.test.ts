import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupportedResponse } from "@x402/core/types";
import { CachedValue, Semaphore, TimeoutError, TtlMap, hedged, withTimeout } from "../src/cache.js";
import { assertSupportsExactV2, createFacilitator, supportsExactV2 } from "../src/facilitator.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const never = () => new Promise<never>(() => undefined);

test("withTimeout: resolves, rejects and times out without leaving a timer behind", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000), /boom/);
  const started = Date.now();
  await assert.rejects(withTimeout(never(), 30), TimeoutError);
  assert.ok(Date.now() - started < 1000);
});

test("cached value: served from memory inside the TTL, reloaded after it", async () => {
  const time = clock();
  let loads = 0;
  const value = new CachedValue({ load: async () => ++loads, ttlMs: 1000, timeoutMs: 100, now: time.now });
  assert.equal(await value.get(), 1);
  time.advance(999);
  assert.equal(await value.get(), 1);
  time.advance(2);
  assert.equal(await value.get(), 2);
  assert.equal(loads, 2);
});

test("cached value: concurrent callers share one load", async () => {
  let loads = 0;
  const value = new CachedValue({
    load: async () => {
      loads++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "x";
    },
    ttlMs: 1000,
    timeoutMs: 500,
  });
  assert.deepEqual(await Promise.all([value.get(), value.get(), value.get()]), ["x", "x", "x"]);
  assert.equal(loads, 1);
});

test("cached value: a smaller maxAge forces a refresh before the TTL ends", async () => {
  const time = clock();
  let loads = 0;
  const value = new CachedValue({ load: async () => ++loads, ttlMs: 5000, timeoutMs: 100, now: time.now });
  await value.get();
  time.advance(600);
  assert.equal(await value.get(), 1);
  assert.equal(await value.get(500), 2);
});

test("cached value: a failed refresh serves the last good value until it is too old", async () => {
  const time = clock();
  let fail = false;
  const value = new CachedValue({
    load: async () => {
      if (fail) throw new Error("upstream down");
      return "good";
    },
    ttlMs: 1000,
    timeoutMs: 100,
    maxStaleMs: 10_000,
    now: time.now,
  });
  assert.equal(await value.get(), "good");
  fail = true;
  time.advance(2000);
  assert.equal(await value.get(), "good"); // stale, served because the refresh failed
  time.advance(9000);
  await assert.rejects(value.get(), /upstream down/); // 11 s old: beyond maxStale
});

test("cached value: without maxStale a failure is an error, and failures are never cached", async () => {
  const time = clock();
  let calls = 0;
  const value = new CachedValue({
    load: async () => {
      if (++calls === 1) throw new Error("first fails");
      return "ok";
    },
    ttlMs: 1000,
    timeoutMs: 100,
    now: time.now,
  });
  await assert.rejects(value.get(), /first fails/);
  assert.equal(await value.get(), "ok"); // the very next call retries
});

test("cached value: a hung load times out and then falls back to the stale value", async () => {
  const time = clock();
  let hang = false;
  const value = new CachedValue<string>({
    load: () => (hang ? never() : Promise.resolve("fresh")),
    ttlMs: 10,
    timeoutMs: 40,
    maxStaleMs: 60_000,
    now: time.now,
  });
  await value.get();
  hang = true;
  time.advance(100);
  const started = Date.now();
  assert.equal(await value.get(), "fresh");
  assert.ok(Date.now() - started < 1000);
  const empty = new CachedValue<string>({ load: never, ttlMs: 10, timeoutMs: 40 });
  await assert.rejects(empty.get(), TimeoutError);
});

test("cached value: a rejected validation is neither cached nor served as stale", async () => {
  let candidate = "bad";
  const value = new CachedValue({
    load: async () => candidate,
    validate: (v: string) => {
      if (v === "bad") throw new Error("invalid");
    },
    ttlMs: 1000,
    timeoutMs: 100,
    maxStaleMs: 60_000,
  });
  await assert.rejects(value.get(), /invalid/);
  assert.equal(value.peek(), undefined);
  candidate = "good";
  assert.equal(await value.get(), "good");
});

test("ttl map: entries expire, the oldest are evicted and the size is bounded", () => {
  const time = clock();
  const map = new TtlMap<number, string>(3, 1000, time.now);
  map.set(1, "a");
  map.set(2, "b");
  map.set(3, "c");
  map.set(4, "d");
  assert.equal(map.get(1), undefined); // evicted
  assert.equal(map.size, 3);
  assert.equal(map.get(4), "d");
  time.advance(1001);
  assert.equal(map.get(4), undefined); // expired
  map.set(5, "e", 5000);
  time.advance(2000);
  assert.equal(map.get(5), "e"); // per-entry TTL
});

test("semaphore: grants up to the limit and frees a slot exactly once", () => {
  const semaphore = new Semaphore(2);
  const a = semaphore.tryAcquire();
  const b = semaphore.tryAcquire();
  assert.ok(a && b);
  assert.equal(semaphore.tryAcquire(), undefined);
  a();
  a(); // double release must not hand out an extra slot
  assert.ok(semaphore.tryAcquire());
  assert.equal(semaphore.tryAcquire(), undefined);
});

const kinds = (...entries: [string, string, number][]): SupportedResponse =>
  ({
    kinds: entries.map(([network, scheme, x402Version]) => ({ network, scheme, x402Version })),
    extensions: [],
    signers: {},
  }) as unknown as SupportedResponse;

test("supported kinds: only exact scheme under x402 v2 on the selected network counts", () => {
  assert.equal(supportsExactV2(kinds(["eip155:143", "exact", 2]), "eip155:143"), true);
  assert.equal(supportsExactV2(kinds(["eip155:143", "exact", 1]), "eip155:143"), false);
  assert.equal(
    supportsExactV2(kinds(["eip155:143", "upto", 2], ["eip155:143", "batch-settlement", 2]), "eip155:143"),
    false,
  );
  assert.equal(supportsExactV2(kinds(["eip155:10143", "exact", 2]), "eip155:143"), false);
  assert.throws(() => assertSupportsExactV2(kinds(), "eip155:143"), /does not support/);
});

test("facilitator cache: one lookup serves ten minutes of requests", async () => {
  const time = clock();
  let lookups = 0;
  const probe = {
    getSupported: async () => {
      lookups++;
      return kinds(["eip155:143", "exact", 2]);
    },
  };
  const handle = createFacilitator({
    url: "https://f.invalid",
    network: "eip155:143",
    probe,
    io: probe as never,
    now: time.now,
    onError: () => undefined,
  });
  await handle.ensureSupported();
  await handle.client.getSupported();
  time.advance(9 * 60_000);
  await handle.ensureSupported();
  assert.equal(lookups, 1);
  time.advance(2 * 60_000);
  await handle.ensureSupported();
  assert.equal(lookups, 2);
});

test("facilitator cache: a hung facilitator fails fast, never after 90 seconds", async () => {
  const probe = { getSupported: never };
  const handle = createFacilitator({
    url: "https://f.invalid",
    network: "eip155:143",
    probe,
    io: probe as never,
    timeoutMs: 40,
    onError: () => undefined,
  });
  const started = Date.now();
  await assert.rejects(handle.ensureSupported(), TimeoutError);
  assert.ok(Date.now() - started < 1000);
});

test("facilitator cache: refresh failure serves the stale answer, a facilitator that drops the network is refused", async () => {
  const time = clock();
  let mode: "ok" | "down" | "dropped" = "ok";
  const probe = {
    getSupported: async () => {
      if (mode === "down") throw new Error("503 from facilitator");
      return mode === "ok" ? kinds(["eip155:143", "exact", 2]) : kinds(["eip155:10143", "exact", 2]);
    },
  };
  const handle = createFacilitator({
    url: "https://f.invalid",
    network: "eip155:143",
    probe,
    io: probe as never,
    now: time.now,
    onError: () => undefined,
  });
  await handle.ensureSupported();
  mode = "down";
  time.advance(11 * 60_000);
  await handle.ensureSupported(); // stale answer, 11 minutes old
  mode = "dropped";
  time.advance(11 * 60_000);
  await handle.ensureSupported(); // the new answer fails the safety check, so the stale one still stands
  time.advance(61 * 60_000);
  await assert.rejects(handle.ensureSupported(), /does not support/); // stale beyond an hour: refuse
});

test("facilitator cache: a first answer without the network is refused outright", async () => {
  const probe = { getSupported: async () => kinds(["eip155:10143", "exact", 2]) };
  const handle = createFacilitator({
    url: "https://f.invalid",
    network: "eip155:143",
    probe,
    io: probe as never,
    onError: () => undefined,
  });
  await assert.rejects(handle.ensureSupported(), /does not support/);
});

test("facilitator cache: a stalled first lookup is covered by the hedged second one", async () => {
  let lookups = 0;
  const probe = {
    getSupported: () => (++lookups === 1 ? never() : Promise.resolve(kinds(["eip155:143", "exact", 2]))),
  };
  const handle = createFacilitator({
    url: "https://f.invalid",
    network: "eip155:143",
    probe,
    io: probe as never,
    hedgeAfterMs: 30,
    timeoutMs: 2000,
    onError: () => undefined,
  });
  const started = Date.now();
  await handle.ensureSupported();
  assert.equal(lookups, 2);
  assert.ok(Date.now() - started < 1500, "the request must not wait for the full timeout");
});

test("hedged: a stalled first attempt is covered by a second one after the hedge delay", async () => {
  let calls = 0;
  const started = Date.now();
  const value = await hedged(() => (++calls === 1 ? never() : Promise.resolve("second")), 30);
  assert.equal(value, "second");
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 1000);
});

test("hedged: a quick failure starts the second attempt immediately, a success never starts one", async () => {
  let calls = 0;
  const started = Date.now();
  assert.equal(await hedged(async () => (++calls === 1 ? Promise.reject(new Error("blip")) : "ok"), 60_000), "ok");
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 1000, "must not wait for the hedge delay after a failure");
  let single = 0;
  assert.equal(await hedged(async () => (++single, "fast"), 20), "fast");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(single, 1);
});

test("hedged: rejects only when both attempts failed", async () => {
  let calls = 0;
  await assert.rejects(
    hedged(async () => {
      calls++;
      throw new Error(`down ${calls}`);
    }, 10),
    /down 2/,
  );
  assert.equal(calls, 2);
});
